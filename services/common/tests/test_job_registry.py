"""Behavioral coverage for the shared in-memory TTL job registry."""

from services.common.job_registry import JobRegistry


def test_registry_prunes_only_expired_terminal_jobs() -> None:
    """Retain active and recent jobs while dropping expired terminal records."""
    now = [100.0]
    ids = iter(("active", "expired", "recent"))
    registry = JobRegistry(
        ttl_seconds=10,
        terminal_statuses=("completed", "failed", "cancelled"),
        clock=lambda: now[0],
        id_factory=lambda: next(ids),
    )
    active = registry.create({"status": "queued"})
    expired = registry.create({"status": "completed"})
    now[0] = 105.0
    recent = registry.create({"status": "failed"})
    now[0] = 111.0

    assert registry.prune() == 1
    assert registry.jobs == {"active": active, "recent": recent}
    assert expired["job_id"] == "expired"


def test_registry_projects_payload_fields_without_changing_shape() -> None:
    """Return exactly the caller-owned public fields in caller order."""
    registry = JobRegistry(
        ttl_seconds=10,
        terminal_statuses=("completed",),
        clock=lambda: 123.0,
        id_factory=lambda: "job-id",
    )
    job = registry.create({"status": "queued", "title": "Track"})

    assert registry.payload(job, ("job_id", "status", "missing", "created_at")) == {
        "job_id": "job-id",
        "status": "queued",
        "missing": None,
        "created_at": 123.0,
    }
