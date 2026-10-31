# ML pipeline image: data ingestion, Box-Tiao, TFT training and batch forecasting.
# Build from the repository root so the shared schema can be copied in:
#   docker build -f ml/Dockerfile -t coe-ml:v1 .
# this starts from slim Python so that the image stays small
FROM python:3.12-slim

# these settings stop cache files and buffered logs so that the image is smaller and logs show up at
# once
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# this installs CPU-only PyTorch (~200 MB instead of ~2 GB for the CUDA build) so that the image
# fits on the VM
RUN pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu

# this installs dependencies before the code so that a code change does not reinstall them
COPY ml/requirements.txt .
RUN pip install -r requirements.txt

# this copies the schema, code, tests and data snapshot so that the job can also run offline
COPY db/init.sql /app/schema.sql
COPY ml/coe_ml /app/coe_ml
COPY ml/tests /app/tests
COPY ml/data/snapshot /app/data/snapshot

# this points the code at the data folder so that the snapshot can be found
ENV COE_DATA_DIR=/app/data

# this runs as an unprivileged user so that the job does not have root inside the container
RUN useradd --create-home --uid 1000 coe && chown -R coe:coe /app
USER coe

# this makes the package the entry point so that "run" can be swapped for another command
ENTRYPOINT ["python", "-m", "coe_ml"]
CMD ["run"]
