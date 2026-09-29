# Web front end: static files served by nginx on Alpine Linux (as in the Week 4 lab).
# Build from the repository root:
#   docker build -f frontend/Dockerfile -t coe-web:v1 .
FROM nginx:alpine

# The official image runs envsubst on /etc/nginx/templates/*.template at start-up.
ENV API_UPSTREAM=api:8000
COPY frontend/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY frontend/public /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost/ > /dev/null || exit 1
