# REST API image (FastAPI + Uvicorn). Build from the repository root:
#   docker build -f backend/Dockerfile -t coe-api:v1 .
# this starts from slim Python so that the image stays small
FROM python:3.12-slim

# these settings stop cache files and buffered logs so that the image is smaller and logs show up at
# once
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
# this installs dependencies before the code so that a code change does not reinstall them
COPY backend/requirements.txt .
RUN pip install -r requirements.txt

# this copies the schema, the app and the tests so that the container can migrate and run its tests
COPY db/init.sql /app/schema.sql
COPY backend/app /app/app
COPY backend/tests /app/tests

# this runs as a normal user so that the app does not have root inside the container
RUN useradd --create-home --uid 1000 coe && chown -R coe:coe /app
USER coe

EXPOSE 8000
# this checks the health route so that Docker can tell if the API is really working
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health', timeout=4)"

# two worker processes serve requests in parallel (Week 2: processes and parallelism) so that one
# slow request does not block the rest
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2", "--proxy-headers"]
