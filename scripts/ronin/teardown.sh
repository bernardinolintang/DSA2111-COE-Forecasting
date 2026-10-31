#!/usr/bin/env bash
# Remove the whole deployment (pods, services, jobs, database volume) to free
# resources on the shared Ronin VM.
# this stops on any error so that a failed delete is not missed
set -euo pipefail

NAMESPACE="coe-g7"
# this asks first so that the database cannot be deleted by accident
read -r -p "Delete namespace $NAMESPACE and ALL its data, including the database? [y/N] " answer
[[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "Cancelled."; exit 0; }
microk8s kubectl delete namespace "$NAMESPACE"
