#!/usr/bin/env bash
# Show the state of the COE Forecast deployment, and optionally demo self-healing.
#
#   bash scripts/ronin/status.sh            # pods, services, jobs, autoscaler
#   bash scripts/ronin/status.sh heal       # delete an API pod and watch it come back
#   bash scripts/ronin/status.sh scale 4    # scale the web tier to 4 replicas
# this stops on any error so that a failed command is not missed
set -euo pipefail

NAMESPACE="coe-g7"
KUBECTL="microk8s kubectl -n $NAMESPACE"

# this picks the action so that one script covers all the demos
case "${1:-status}" in
  # this lists everything so that we can see the state of the deployment
  status)
    $KUBECTL get deployments,pods,svc,hpa,cronjobs,jobs -o wide
    ;;
  # this deletes a pod so that we can show Kubernetes replace it by itself
  heal)
    pod="$($KUBECTL get pods -l app=coe-api -o jsonpath='{.items[0].metadata.name}')"
    echo "Deleting $pod ... Kubernetes should start a replacement immediately."
    $KUBECTL delete pod "$pod" --wait=false
    sleep 2
    $KUBECTL get pods -l app=coe-api -o wide
    ;;
  # this changes the web replicas so that we can show scaling live
  scale)
    replicas="${2:-3}"
    $KUBECTL scale deployment coe-web --replicas="$replicas"
    $KUBECTL rollout status deployment/coe-web
    $KUBECTL get pods -l app=coe-web -o wide
    ;;
  # this starts a job from the CronJob so that a retrain can be shown without waiting for Wednesday
  retrain)
    job="coe-ml-manual-$(date +%s)"
    $KUBECTL create job "$job" --from=cronjob/coe-ml-retrain
    echo "Started $job. Follow it with: microk8s kubectl -n $NAMESPACE logs -f job/$job"
    ;;
  *)
    echo "usage: $0 [status|heal|scale N|retrain]"; exit 1 ;;
esac
