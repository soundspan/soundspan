"""Behavioral coverage for local Chromaprint fingerprint computation."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import fingerprinting
import pytest

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "fpcalc.json"


def test_parse_fpcalc_json_fixture() -> None:
    """Parse the fpcalc JSON contract into persistence-ready values."""
    payload = FIXTURE_PATH.read_text(encoding="utf-8")

    assert fingerprinting.parse_fpcalc_json(payload) == {
        "duration": 247,
        "fingerprint": "AQADtEmiJXEkqZKlQ",
    }


def test_parse_fpcalc_json_accepts_fingerprint_at_size_limit() -> None:
    """Accept a fingerprint whose encoded value is exactly at the persistence cap."""
    fingerprint = "a" * fingerprinting.MAX_FINGERPRINT_BYTES

    assert fingerprinting.parse_fpcalc_json(
        json.dumps({"duration": 1, "fingerprint": fingerprint})
    ) == {"duration": 1, "fingerprint": fingerprint}


def test_parse_fpcalc_json_rejects_fingerprint_over_size_limit() -> None:
    """Reject a fingerprint whose encoded value exceeds the persistence cap."""
    fingerprint = "a" * (fingerprinting.MAX_FINGERPRINT_BYTES + 1)

    assert (
        fingerprinting.parse_fpcalc_json(json.dumps({"duration": 1, "fingerprint": fingerprint}))
        is None
    )


def test_parse_fpcalc_json_rejects_duration_that_rounds_below_one_second() -> None:
    """Reject a positive fractional duration when its persisted integer is zero."""
    assert (
        fingerprinting.parse_fpcalc_json(json.dumps({"duration": 0.5, "fingerprint": "valid"}))
        is None
    )


def test_compute_fingerprint_invokes_bounded_fpcalc(monkeypatch: pytest.MonkeyPatch) -> None:
    """Invoke the resolved binary with JSON output and an explicit timeout."""
    calls: list[tuple[list[str], int]] = []

    def run(command: list[str], timeout: int) -> tuple[int, bytes]:
        calls.append((command, timeout))
        return 0, FIXTURE_PATH.read_bytes()

    monkeypatch.setattr(fingerprinting.shutil, "which", lambda _name: "/usr/bin/fpcalc")
    monkeypatch.setattr(fingerprinting, "_run_fpcalc", run)

    result = fingerprinting.compute_fingerprint("/music/track.flac", timeout_seconds=45)

    assert result is not None
    assert calls == [(["/usr/bin/fpcalc", "-json", "/music/track.flac"], 45)]


def test_compute_fingerprint_rejects_oversized_fpcalc_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject valid fpcalc JSON when the subprocess emits more than the output cap."""
    oversized = json.dumps(
        {
            "duration": 247,
            "fingerprint": "a" * fingerprinting.MAX_FPCALC_OUTPUT_BYTES,
        }
    )

    def run(_command: list[str], _timeout: int) -> tuple[int, bytes]:
        return 0, oversized.encode()

    monkeypatch.setattr(fingerprinting.shutil, "which", lambda _name: "/usr/bin/fpcalc")
    monkeypatch.setattr(fingerprinting, "_run_fpcalc", run)

    assert fingerprinting.compute_fingerprint("/music/track.flac") is None


def test_compute_fingerprint_accepts_fpcalc_output_at_size_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Accept valid fpcalc JSON whose encoded subprocess output is exactly at the cap."""
    empty_payload = json.dumps({"duration": 247, "fingerprint": ""})
    fingerprint = "a" * (fingerprinting.MAX_FPCALC_OUTPUT_BYTES - len(empty_payload.encode()))
    bounded = json.dumps({"duration": 247, "fingerprint": fingerprint}).encode()
    assert len(bounded) == fingerprinting.MAX_FPCALC_OUTPUT_BYTES

    def run(_command: list[str], _timeout: int) -> tuple[int, bytes]:
        return 0, bounded

    monkeypatch.setattr(fingerprinting.shutil, "which", lambda _name: "/usr/bin/fpcalc")
    monkeypatch.setattr(fingerprinting, "_run_fpcalc", run)

    assert fingerprinting.compute_fingerprint("/music/track.flac") == {
        "duration": 247,
        "fingerprint": fingerprint,
    }


def test_missing_fpcalc_logs_once_and_skips(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Keep missing optional tooling silent after its first warning."""
    monkeypatch.setattr(fingerprinting.shutil, "which", lambda _name: None)
    monkeypatch.setattr(fingerprinting, "_missing_binary_logged", False)

    with caplog.at_level(logging.WARNING):
        assert fingerprinting.compute_fingerprint("/music/one.flac") is None
        assert fingerprinting.compute_fingerprint("/music/two.flac") is None

    assert caplog.text.count("fpcalc is unavailable") == 1


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"duration": 0, "fingerprint": "valid"},
        {"duration": 12, "fingerprint": ""},
        {"duration": True, "fingerprint": "valid"},
    ],
)
def test_parse_fpcalc_json_rejects_invalid_values(payload: object) -> None:
    """Reject malformed subprocess output at the trust boundary."""
    assert fingerprinting.parse_fpcalc_json(json.dumps(payload)) is None
