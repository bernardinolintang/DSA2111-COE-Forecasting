# REST API image (FastAPI + Uvicorn). Build from the repository root:
#   docker build -f backend/Dockerfile -t coe-api:v1 .
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install -r requirements.txt

COPY db/init.sql /app/schema.sql
COPY backend/app /app/app
COPY backend/tests /app/tests

RUN useradd --create-home --uid 1000 coe && chown -R coe:coe /app
USER coe

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health', timeout=4)"

# Two worker processes serve requests in parallel (Week 2: processes & parallelism).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--proxy-headers"]
