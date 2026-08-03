"""Workload adapters.

Each adapter drives one category of workload against a running endpoint and emits a uniform
record stream: one NDJSON line per request or generation. Every published metric is derived
from those records, and the server recomputes them from the same file — so the records, not
the summary, are the measurement.
"""

from .base import RawRecord, WorkloadResult, percentile, write_records

__all__ = ["RawRecord", "WorkloadResult", "percentile", "write_records"]
