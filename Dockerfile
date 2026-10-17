# Runs the site with the official Python package: full precision, all four model sizes, on your CPU.
# The GitHub Pages build runs the model in the browser instead.
FROM node:22-alpine AS site
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
ENV PUBLIC_BACKEND=server
RUN npm run build

FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/app.py .
COPY --from=site /app/dist ./dist
# Model weights download from Hugging Face on first use; mount a volume here to keep them.
ENV HF_HOME=/cache
# Plain HTTPS downloads: the Xet transfer client failed inside this container.
ENV HF_HUB_DISABLE_XET=1
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
