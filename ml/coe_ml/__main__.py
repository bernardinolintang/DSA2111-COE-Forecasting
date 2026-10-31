"""Command-line interface:  python -m coe_ml <command> [options]

Commands
  run      full pipeline (ingest, backtest, train, forecast, store)
  ingest   only download data and upsert it into Postgres
  snapshot only download data and refresh ml/data/snapshot/*.csv
"""

from __future__ import annotations

import argparse
import logging

from . import db, ingest
from .config import PipelineConfig, fast_config
from .pipeline import configure_logging, run

# this gives the command line its own logger so that its messages are labelled coe_ml
log = logging.getLogger("coe_ml")


# this reads the command and starts the right job so that one docker image can do every task
def main() -> None:
    # this uses the file docstring as the help text so that the commands only need describing once
    parser = argparse.ArgumentParser(prog="coe_ml", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    # these are the options for the full run so that the same command works for quick tests and real
    # runs
    run_p = sub.add_parser("run", help="run the full pipeline")
    run_p.add_argument("--fast", action="store_true", help="few epochs, for smoke tests")
    run_p.add_argument("--offline", action="store_true", help="use the committed data snapshot")
    run_p.add_argument("--skip-backtest", action="store_true", help="only retrain and forecast")
    run_p.add_argument("--seeds", type=int, default=3, help="ensemble size (default 3)")
    run_p.add_argument("--workers", type=int, help="parallel worker processes")
    run_p.add_argument("--no-db", action="store_true", help="do not write to the database")

    # these two commands only touch the data so that we can refresh it without training
    sub.add_parser("ingest", help="download data and upsert into Postgres")
    sub.add_parser("snapshot", help="refresh the offline CSV snapshot")

    # this parses the command first and turns on logging so that every later step shows up in the
    # logs
    args = parser.parse_args()
    configure_logging()

    # this runs the pipeline with the chosen settings so that --fast and --offline change only the
    # config
    if args.command == "run":
        cfg = fast_config() if args.fast else PipelineConfig()
        if args.workers:
            cfg.n_workers = args.workers
        run(cfg, offline=args.offline, skip_backtest=args.skip_backtest,
            n_seeds=args.seeds, write_db=not args.no_db)
    # this loads the newest data into postgres so that the app can show results without a retrain
    elif args.command == "ingest":
        engine = db.get_engine()
        db.wait_for_db(engine)
        db.ensure_schema(engine)
        db.save_raw_data(engine, ingest.load_coe_results(), ingest.load_macro())
    # this overwrites the committed csv files so that the offline copy stays current
    elif args.command == "snapshot":
        coe, macro = ingest.fetch_coe_results(), ingest.fetch_macro()
        ingest._save_snapshot(coe, "coe_results")
        ingest._save_snapshot(macro, "macro_indicators")
        log.info("Snapshot refreshed: %d COE rows, %d macro rows", len(coe), len(macro))


# this runs main only when called as a script so that importing this file does nothing
if __name__ == "__main__":
    main()
