#!/usr/bin/env bash
# Show the state of the COE Forecast deployment, and optionally demo self-healing.
#
#   bash scripts/ronin/status.sh            # pods, services, jobs, autoscaler
#   bash scripts/ronin/status.sh heal       # delete an API pod and watch it come back
#   bash scripts/ronin/status.sh scale 4    # scale the web tier to 4 replicas
set -euo pipefail

NAMESPACE="coe-g7"
KUBECTL="microk8s kubectl -n $NAMESPACE"

case "${1:-status}" in
  status)
    $KUBECTL get deployments,pods,svc,hpa,cronjobs,jobs -o wide
    ;;
  heal)
    pod="$($KUBECTL get pods -l app=coe-api -o jsonpath='{.items[0].metadata.name}')"
    echo "Deleting $pod ... Kubernetes should start a replacement immediately."
    $KUBECTL delete pod "$pod" --wait=false
    sleep 2
    $KUBECTL get pods -l app=coe-api -o wide
    ;;
  scale)
    replicas="${2:-3}"
    $KUBECTL scale deployment coe-web --replicas="$replicas"
    $KUBECTL rollout status deployment/coe-web
    $KUBECTL get pods -l app=coe-web -o wide
    ;;
  retrain)
    job="coe-ml-manual-$(date +%s)"
    $KUBECTL create job "$job" --from=cronjob/coe-ml-retrain
    echo "Started $job. Follow it with: microk8s kubectl -n $NAMESPACE logs -f job/$job"
    ;;
  *)
    echo "usage: $0 [status|heal|scale N|retrain]"; exit 1 ;;
esac
