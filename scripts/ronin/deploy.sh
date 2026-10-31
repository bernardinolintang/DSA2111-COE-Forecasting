#!/usr/bin/env bash
# =============================================================================
# Deploy COE Forecast to microk8s on the Ronin cloud VM (Week 5 lab workflow).
#
#   ssh exxxxxxx@dsa2111-semester1.nus.cloud
#   git clone <repo> && cd DSA2111-COE-Forecasting
#   bash scripts/ronin/deploy.sh
#
# Steps: enable microk8s add-ons -> build Docker images -> push them to the
# microk8s registry (localhost:32000) -> create the DB secret -> apply the
# manifests with kustomize -> wait for the rollout.
#
# Environment overrides:
#   TAG=v2 bash scripts/ronin/deploy.sh      image tag (default v1)
#   SKIP_ML=1 bash scripts/ronin/deploy.sh   skip building the (large) ML image
# =============================================================================
# this stops on any error so that a half-finished deploy is not missed
set -euo pipefail

cd "$(dirname "$0")/../.."
# these are the deploy settings so that they only need changing here
NAMESPACE="coe-g7"
REGISTRY="localhost:32000"
TAG="${TAG:-v1}"
KUBECTL="microk8s kubectl"

# this prints a coloured heading so that each step is easy to see in the logs
log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

# this checks the tools exist so that the script fails early with a clear message
command -v microk8s >/dev/null || { echo "microk8s is not installed on this machine"; exit 1; }
command -v docker >/dev/null || { echo "docker is not installed on this machine"; exit 1; }

# this turns on the add-ons we need so that a fresh VM works, skipping ones already on
log "Enabling microk8s add-ons (dns, registry, storage, metrics-server)"
for addon in dns registry hostpath-storage metrics-server; do
  microk8s status --addon "$addon" 2>/dev/null | grep -q enabled || microk8s enable "$addon"
done

# this builds and pushes each image so that microk8s can pull them from the local registry
log "Building and pushing images (tag $TAG)"
images=(api web)
[[ "${SKIP_ML:-0}" == "1" ]] || images+=(ml)
for name in "${images[@]}"; do
  case "$name" in
    api) dockerfile=backend/Dockerfile ;;
    web) dockerfile=frontend/Dockerfile ;;
    ml)  dockerfile=ml/Dockerfile ;;
  esac
  docker build -f "$dockerfile" -t "coe-$name:$TAG" .
  docker tag "coe-$name:$TAG" "$REGISTRY/coe-$name:$TAG"
  docker push "$REGISTRY/coe-$name:$TAG"
done

# this creates the namespace safely so that running the script twice is fine
log "Creating namespace and database secret"
$KUBECTL create namespace "$NAMESPACE" --dry-run=client -o yaml | $KUBECTL apply -f -
if ! $KUBECTL -n "$NAMESPACE" get secret coe-db >/dev/null 2>&1; then
  # this makes a random password once and stores it only inside the cluster so that nothing secret
  # is in Git
  $KUBECTL -n "$NAMESPACE" create secret generic coe-db --from-literal=password="$(openssl rand -hex 16)"
fi
# this optional secret holds the COE Analyst's key so that a model can be used, without a key the
# analyst runs in basic mode
#   GROQ_API_KEY=gsk_... bash scripts/ronin/deploy.sh      (or ANTHROPIC_API_KEY=sk-ant-...)
if [[ -n "${GROQ_API_KEY:-}${ANTHROPIC_API_KEY:-}" ]]; then
  $KUBECTL -n "$NAMESPACE" create secret generic coe-analyst \
    --from-literal=groq-api-key="${GROQ_API_KEY:-}" --from-literal=anthropic-api-key="${ANTHROPIC_API_KEY:-}" \
    --dry-run=client -o yaml | $KUBECTL apply -f -
fi

# this applies the manifests so that every Kubernetes object is created or updated
log "Applying manifests"
if [[ "$TAG" != "v1" ]]; then
  # this points kustomize at the new tag without editing the committed file so that the repo stays
  # clean
  overlay="$(mktemp -d)"
  cp k8s/*.yaml "$overlay/"
  sed -i "s/newTag: v1/newTag: $TAG/" "$overlay/kustomization.yaml"
  $KUBECTL apply -k "$overlay"
else
  $KUBECTL apply -k k8s/
fi

# this waits for the pods so that the script only says deployed when they are ready
log "Waiting for pods"
$KUBECTL -n "$NAMESPACE" rollout status deployment/coe-db --timeout=180s
$KUBECTL -n "$NAMESPACE" rollout status deployment/coe-api --timeout=180s
$KUBECTL -n "$NAMESPACE" rollout status deployment/coe-web --timeout=120s
$KUBECTL -n "$NAMESPACE" get pods -o wide

# this finds the NodePort so that the message below can show the tunnel command
node_port="$($KUBECTL -n "$NAMESPACE" get svc coe-web -o jsonpath='{.spec.ports[0].nodePort}')"
cat <<EOF

Deployed. The first model is training in the background:
  $KUBECTL -n $NAMESPACE logs -f job/coe-ml-initial

Open the app from your laptop with an SSH tunnel:
  ssh -L 8080:localhost:$node_port $(whoami)@dsa2111-semester1.nus.cloud
  then browse to http://localhost:8080
EOF
