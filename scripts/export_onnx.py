"""Export one Timestral decoding step to ONNX so the website can run the model in the browser.

The graph covers `predict_block` plus `_refine_block`, and also returns the last-patch scale used
to cap the quantiles. The block length (1 to 32 patches) is the length of the `known_future` input. The block loop, feedback, symmetric
averaging and clipping stay in JS (web/src/lib/timestral.js), mirroring timestral/forecaster.py.

Writes the fp32 graph to onnx/ (used by tests/parity) and a copy with fp16-stored weights,
half the download with fp32 math, to web/public/models/ for the site.

Run from the repo root:  python scripts/export_onnx.py 5M 28M
"""

import sys
from pathlib import Path

import numpy as np
import onnx
import torch
from onnx import numpy_helper
import timestral.masks as masks
import timestral.model as model_module
import timestral.scaler as scaler
from timestral import TimestralForecaster
from timestral.model import ROLE_TARGET, TimestralModel, apply_affine_asinh_masked, instance_norm_stats
from timestral.scaler import advancing_block_frames, causal_patch_loc_scale, clamp_nonfinite, welford_combine

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "onnx"
SITE_MODELS = ROOT / "web" / "public" / "models"
BLOCK_PATCHES = 32


def _key_validity(obs_per_patch, attend_missing):
    # ONNX has no cummax; "started" is the same as "any observed patch so far".
    return obs_per_patch if not attend_missing else obs_per_patch | (obs_per_patch.to(torch.int32).cumsum(-1) > 0)


def _known_cov_scaling(self, inputs, observed, scaled, loc, scale, known_rows):
    # Same as TimestralModel._known_cov_scaling without its data-dependent early return,
    # which ONNX cannot trace; with no known rows the torch.where calls are a no-op.
    loc_c, scale_c, is_binary = instance_norm_stats(inputs, observed, minimum_scale=self.config.minimum_scale)
    known_scaled = apply_affine_asinh_masked(inputs, loc_c, scale_c, observed, use_asinh=False)
    if self.config.use_asinh:
        work = torch.promote_types(known_scaled.dtype, torch.float32)
        squashed = known_scaled.to(work).asinh().to(known_scaled.dtype)
        known_scaled = torch.where(observed & ~is_binary, squashed, known_scaled)
    sel = known_rows[:, None]
    return torch.where(sel, known_scaled, scaled), torch.where(sel, loc_c, loc), torch.where(sel, scale_c, scale)


def _cumulative_welford(w, mean, m2):
    # The package scans with `while d < n`, which export freezes at the traced length.
    # A fixed 11 steps cover 2048 patches (the max is 1024 + 32); once d >= n the shifted
    # state is all zeros, and merging with the zero state is the identity.
    n = w.shape[1]
    for k in range(11):
        d = 1 << k
        shift = lambda s: torch.cat([s.new_zeros(s.shape[0], d), s], dim=1)[:, :n]
        w, mean, m2 = welford_combine(shift(w), shift(mean), shift(m2), w, mean, m2)
    return w, mean, m2


masks.compute_enc_key_validity = _key_validity
scaler.cumulative_welford = _cumulative_welford
model_module.compute_enc_key_validity = _key_validity  # model.py imports it by name
TimestralModel._known_cov_scaling = _known_cov_scaling


class Step(torch.nn.Module):
    def __init__(self, forecaster: TimestralForecaster):
        super().__init__()
        self.f = forecaster
        self.model = forecaster.model

    def forward(self, x, obs, group_ids, role_ids, known_future, known_future_mask):
        c = self.model.config
        ps, hlen = c.patch_size, known_future.shape[1]
        q = self.model._predict_window(
            torch.cat([x, known_future], -1), torch.cat([obs, known_future_mask], -1),
            group_ids, hlen // ps, role_ids)
        q = self.refine(q, x, obs, role_ids == ROLE_TARGET)
        _, scale = causal_patch_loc_scale(x, obs, ps, c.minimum_scale, c.stabilize_with_global)
        return q, scale[..., -1]

    def refine(self, quantiles, context, mask, target_rows):
        """TimestralForecaster._refine_block over a fixed 32-patch block, sliced back to the real length.

        Patch j's frame only uses the medians of patches 0..j-1, so the zero padding after the
        block changes nothing; with one patch this returns the input like the original.
        """
        ps, hlen = self.model.config.patch_size, quantiles.shape[1]
        full = BLOCK_PATCHES * ps
        _, loc, scale = self.model.scale(context, mask)
        loc0, scale0 = loc[:, -1], scale[:, -1]
        padded = torch.cat([quantiles, quantiles.new_zeros(quantiles.shape[0], full - hlen, quantiles.shape[2])], 1)
        median = padded[..., self.f.median_index].unflatten(-1, (BLOCK_PATCHES, ps)).to(torch.float64)
        sinh_median = (median - loc0[:, None, None]) / scale0[:, None, None]
        loc_j, scale_j = advancing_block_frames(context, mask, sinh_median, self.model.config.minimum_scale)
        first = torch.zeros(loc_j.shape, dtype=torch.bool, device=loc_j.device)
        first[:, 0] = True
        # expand + reshape instead of repeat_interleave, whose decomposition has a data-dependent size.
        per_step = lambda v: v[..., None].expand(-1, -1, ps).reshape(v.shape[0], full)[:, :hlen]
        loc_j = per_step(torch.where(first, loc0[:, None], loc_j.to(quantiles.dtype)))
        scale_j = per_step(torch.where(first, scale0[:, None], scale_j.to(quantiles.dtype)))
        sinh_norm = (quantiles - loc0[:, None, None]) / scale0[:, None, None]
        refined = clamp_nonfinite(sinh_norm * scale_j[..., None] + loc_j[..., None])
        return torch.where(target_rows[:, None, None], refined, quantiles)


def rewrite_bool_where(path: Path) -> None:
    """onnxruntime-web/node have no bool Where kernel: rewrite it as (c AND a) OR (NOT c AND b)."""
    m = onnx.load(path)
    # Inferred shapes are only used to read dtypes; saving them can pin wrong symbolic dims.
    inferred = onnx.shape_inference.infer_shapes(m).graph
    types = {v.name: v.type.tensor_type.elem_type for v in [*inferred.value_info, *inferred.input, *inferred.output]}
    types.update({t.name: t.data_type for t in m.graph.initializer})
    nodes = []
    for n in m.graph.node:
        if n.op_type == "Where" and types.get(n.input[1]) == onnx.TensorProto.BOOL:
            c, a, b = n.input
            nodes += [
                onnx.helper.make_node("Not", [c], [f"{n.name}_nc"]),
                onnx.helper.make_node("And", [c, a], [f"{n.name}_ca"]),
                onnx.helper.make_node("And", [f"{n.name}_nc", b], [f"{n.name}_ncb"]),
                onnx.helper.make_node("Or", [f"{n.name}_ca", f"{n.name}_ncb"], list(n.output), name=n.name),
            ]
        else:
            nodes.append(n)
    del m.graph.node[:]
    m.graph.node.extend(nodes)
    onnx.save(m, path)


def fp16_storage(src: Path, dst: Path) -> None:
    """Store large fp32 weights as fp16 with a Cast back to fp32; onnxruntime folds the casts at load.

    int8 quantization moved forecasts by up to 84% of their range; this stays within about 3e-4.
    """
    m = onnx.load(src)
    keep, casts = [], []
    for init in m.graph.initializer:
        a = numpy_helper.to_array(init)
        if a.dtype == np.float32 and a.size >= 1024:
            half = numpy_helper.from_array(a.astype(np.float16), init.name + "_fp16")
            keep.append(half)
            casts.append(onnx.helper.make_node("Cast", [half.name], [init.name], to=onnx.TensorProto.FLOAT))
        else:
            keep.append(init)
    nodes = casts + list(m.graph.node)
    del m.graph.initializer[:], m.graph.node[:]
    m.graph.initializer.extend(keep)
    m.graph.node.extend(nodes)
    dst.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(m, dst)


def export(size: str) -> Path:
    f = TimestralForecaster.from_pretrained(f"mistralai/Timestral-{size}")
    f.model.eval()
    ps = f.patch_size
    r, t, h = 2, 64 * ps, 7 * ps  # a block below the max, so export does not specialise on it
    args = (torch.randn(r, t).cumsum(-1), torch.ones(r, t, dtype=torch.bool), torch.tensor([0, 1]),
            torch.zeros(r, dtype=torch.long), torch.zeros(r, h), torch.zeros(r, h, dtype=torch.bool))
    rows, patches = torch.export.Dim("rows", min=1, max=64), torch.export.Dim("patches", min=1, max=1024)
    block = torch.export.Dim("block", min=1, max=BLOCK_PATCHES)
    path = OUT / f"timestral-{size.lower()}.onnx"
    OUT.mkdir(exist_ok=True)
    shapes = ({0: rows, 1: ps * patches}, {0: rows, 1: ps * patches}, {0: rows}, {0: rows},
              {0: rows, 1: ps * block}, {0: rows, 1: ps * block})
    # Export first, then convert: letting torch.onnx.export trace by itself trips a bogus
    # data-dependent assert on the dynamic block length.
    program = torch.export.export(Step(f), args, dynamic_shapes=shapes, strict=False)
    torch.onnx.export(program, args, path, dynamo=True, external_data=False,
                      input_names=["x", "obs", "group_ids", "role_ids", "known_future", "known_future_mask"],
                      output_names=["quantiles", "last_scale"])
    rewrite_bool_where(path)
    fp16_storage(path, SITE_MODELS / path.name)
    return path


if __name__ == "__main__":
    for size in sys.argv[1:] or ["5M", "28M"]:
        print(size, export(size))
