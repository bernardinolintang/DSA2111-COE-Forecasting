"""Process-level parallelism shared by the pipeline stages.

Independent work (one ARIMA fit per category, one neural net per random seed)
runs in separate worker *processes*, so it scales across CPU cores without
Python's GIL getting in the way (Week 2: processes vs threads).

We use the ``spawn`` start method rather than ``fork``: once PyTorch or BLAS
has started its own thread pools in the parent, a forked child inherits locks
held by threads that no longer exist and can deadlock or crash. ``spawn``
starts each worker as a fresh interpreter, which is slower to start but safe.
"""

from __future__ import annotations

import multiprocessing
from concurrent.futures import ProcessPoolExecutor
from typing import Callable, Iterable, TypeVar

# these type variables say the output follows fn so that the signature stays readable
T = TypeVar("T")
R = TypeVar("R")


def parallel_map(fn: Callable[[T], R], items: Iterable[T], n_workers: int) -> list[R]:
    """``[fn(x) for x in items]``, in up to ``n_workers`` processes."""
    items = list(items)
    # this stays in the same process when there is nothing to split so that small jobs skip the
    # worker start-up cost
    if n_workers <= 1 or len(items) <= 1:
        return [fn(item) for item in items]
    # this uses spawn workers so that PyTorch thread pools cannot deadlock a forked child
    context = multiprocessing.get_context("spawn")
    with ProcessPoolExecutor(max_workers=min(n_workers, len(items)), mp_context=context) as pool:
        return list(pool.map(fn, items))
