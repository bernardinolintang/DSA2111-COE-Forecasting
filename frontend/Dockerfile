# Web front end: static files served by nginx on Alpine Linux (as in the Week 4 lab).
# Build from the repository root:
#   docker build -f frontend/Dockerfile -t coe-web:v1 .
# this uses nginx on Alpine so that the image is tiny
FROM nginx:alpine

# the official image runs envsubst on /etc/nginx/templates/*.template at start-up so that the API
# address can be set per environment
ENV API_UPSTREAM=api:8000
COPY frontend/nginx/default.conf.template /etc/nginx/templates/default.conf.template
# this copies the static site so that nginx can serve it
COPY frontend/public /usr/share/nginx/html

EXPOSE 80
# this checks the home page so that Docker can tell if nginx is working
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ > /dev/null || exit 1
