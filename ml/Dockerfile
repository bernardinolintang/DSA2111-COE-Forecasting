# ML pipeline image: data ingestion, Box-Tiao, TFT training and batch forecasting.
# Build from the repository root so the shared schema can be copied in:
#   docker build -f ml/Dockerfile -t coe-ml:v1 .
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# CPU-only PyTorch (~200 MB instead of ~2 GB for the CUDA build).
RUN pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu

COPY ml/requirements.txt .
RUN pip install -r requirements.txt

COPY db/init.sql /app/schema.sql
COPY ml/coe_ml /app/coe_ml
COPY ml/tests /app/tests
COPY ml/data/snapshot /app/data/snapshot

ENV COE_DATA_DIR=/app/data

# Run as an unprivileged user.
RUN useradd --create-home --uid 1000 coe && chown -R coe:coe /app
USER coe

ENTRYPOINT ["python", "-m", "coe_ml"]
CMD ["run"]
