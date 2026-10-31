#!/usr/bin/env bash
# Re-run the ML pipeline locally (docker compose) after a new bidding exercise.
#
#   bash scripts/retrain.sh           # full run: backtest + train + forecast (~10 min)
#   bash scripts/retrain.sh --quick   # skip the backtest: train + forecast only (~1 min)
#
# To automate it on a Linux VM, add a cron entry (crontab -e), e.g. every
# Wednesday 17:30:   30 17 * * 3  cd /path/to/repo && bash scripts/retrain.sh --quick
# this stops on any error so that a failed run is not missed
set -euo pipefail

cd "$(dirname "$0")/.."
# this adds --skip-backtest for --quick so that a small update takes about a minute
args=(run)
[[ "${1:-}" == "--quick" ]] && args+=(--skip-backtest)
docker compose run --rm ml "${args[@]}"
