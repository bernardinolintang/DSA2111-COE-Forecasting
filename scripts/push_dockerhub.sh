#!/usr/bin/env bash
# Tag and push the three images to Docker Hub (Week 4, lab activity 7), so any
# machine can pull and run the app without building it.
#
#   docker login
#   DOCKERHUB_USER=yourname TAG=v1 bash scripts/push_dockerhub.sh
set -euo pipefail

cd "$(dirname "$0")/.."
: "${DOCKERHUB_USER:?set DOCKERHUB_USER to your Docker Hub username}"
TAG="${TAG:-v1}"

docker compose build
for name in api web ml; do
  docker tag "coe-$name:latest" "$DOCKERHUB_USER/coe-$name:$TAG"
  docker push "$DOCKERHUB_USER/coe-$name:$TAG"
done
echo "Pushed $DOCKERHUB_USER/coe-{api,web,ml}:$TAG"
