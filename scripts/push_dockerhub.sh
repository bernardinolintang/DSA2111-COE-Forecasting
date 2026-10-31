#!/usr/bin/env bash
# Tag and push the three images to Docker Hub (Week 4, lab activity 7), so any
# machine can pull and run the app without building it.
#
#   docker login
#   DOCKERHUB_USER=yourname TAG=v1 bash scripts/push_dockerhub.sh
# this stops on any error so that a failed push is not missed
set -euo pipefail

# this requires a username so that images cannot go to the wrong account
cd "$(dirname "$0")/.."
: "${DOCKERHUB_USER:?set DOCKERHUB_USER to your Docker Hub username}"
TAG="${TAG:-v1}"

# this builds all images then tags and pushes each one so that the three versions always match
docker compose build
for name in api web ml; do
  docker tag "coe-$name:latest" "$DOCKERHUB_USER/coe-$name:$TAG"
  docker push "$DOCKERHUB_USER/coe-$name:$TAG"
done
echo "Pushed $DOCKERHUB_USER/coe-{api,web,ml}:$TAG"
