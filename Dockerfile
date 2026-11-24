# Stage 1: build the screens
FROM node:22-slim AS screens
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: the service
FROM python:3.11-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ backend/
COPY data/ data/
COPY --from=screens /build/dist frontend/dist
RUN useradd --system --uid 10001 claims && mkdir -p /app/state && chown claims /app/state
USER claims
ENV CLAIMS_STATE_DIR=/app/state
EXPOSE 8000
# proxy headers on: the app sits behind a reverse proxy and needs the visitor's address to limit login attempts
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
