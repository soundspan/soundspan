"""Shared bounded in-memory registry for ephemeral sidecar jobs."""

from __future__ import annotations

import time
from collections.abc import Callable, Collection, Mapping, Sequence
from typing import Any
from uuid import uuid4

Job = dict[str, Any]


class JobRegistry:
    """Own one TTL-bounded dictionary of sidecar job records."""

    def __init__(
        self,
        *,
        ttl_seconds: float,
        terminal_statuses: Collection[str],
        clock: Callable[[], float] = time.time,
        id_factory: Callable[[], str] | None = None,
    ) -> None:
        if ttl_seconds <= 0:
            raise ValueError("Job registry TTL must be positive")
        if not terminal_statuses:
            raise ValueError("Job registry terminal statuses must not be empty")
        self.ttl_seconds = ttl_seconds
        self.terminal_statuses = frozenset(terminal_statuses)
        self.clock = clock
        self.id_factory = id_factory or (lambda: uuid4().hex)
        self.jobs: dict[str, Job] = {}

    def prune(self) -> int:
        """Remove expired terminal jobs and return the removal count."""
        cutoff = self.clock() - self.ttl_seconds
        stale_ids = [
            job_id
            for job_id, job in self.jobs.items()
            if job.get("status") in self.terminal_statuses and _created_at(job) <= cutoff
        ]
        for job_id in stale_ids:
            del self.jobs[job_id]
        return len(stale_ids)

    def create(self, fields: Mapping[str, Any]) -> Job:
        """Prune the registry, add one timestamped job, and return it."""
        self.prune()
        if "job_id" in fields or "created_at" in fields:
            raise ValueError("Job fields cannot replace registry-owned values")
        job_id = self.id_factory()
        if not job_id or job_id in self.jobs:
            raise RuntimeError("Job registry generated an invalid or duplicate id")
        job: Job = {"job_id": job_id, **fields, "created_at": self.clock()}
        self.jobs[job_id] = job
        return job

    @staticmethod
    def payload(job: Mapping[str, Any], fields: Sequence[str]) -> Job:
        """Project one job into its caller-owned public payload shape."""
        return {field: job.get(field) for field in fields}


def _created_at(job: Mapping[str, Any]) -> float:
    """Return a safe comparable creation time for pruning."""
    created_at = job.get("created_at", 0)
    if isinstance(created_at, bool) or not isinstance(created_at, (int, float)):
        return 0.0
    return float(created_at)
