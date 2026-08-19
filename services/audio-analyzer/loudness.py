"""Full-program EBU R128 loudness measurement through ffmpeg."""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
from typing import Literal, TypedDict

from services.common.logging_utils import configure_service_logger

DEFAULT_LOUDNESS_TIMEOUT_SECONDS = 120
MIN_LOUDNESS_TIMEOUT_SECONDS = 1
MAX_LOUDNESS_TIMEOUT_SECONDS = 3600
MIN_LOUDNESS_LUFS = -70.0
MAX_LOUDNESS_LUFS = 0.0
MIN_TRUE_PEAK_DB = -70.0
MAX_TRUE_PEAK_DB = 10.0

logger = configure_service_logger("audio-analyzer").getChild("Loudness")


class LoudnessMeasurement(TypedDict):
    """Validated EBU R128 values persisted for one track."""

    loudnessLufs: float
    truePeakDb: float


LoudnessFailureClass = Literal["permanent", "transient"]


class LoudnessMeasurementResult(TypedDict):
    """One measurement or a classified failure for backfill policy."""

    measurement: LoudnessMeasurement | None
    failure: LoudnessFailureClass | None


ALBUM_LOUDNESS_LOCK_SQL = """
    SELECT pg_advisory_xact_lock(hashtextextended("albumId", 0))
    FROM "Track"
    WHERE id = %s
"""


ALBUM_LOUDNESS_ROLLUP_SQL = """
    WITH saved_album AS (
        SELECT "albumId"
        FROM "Track"
        WHERE id = %s
    ),
    aggregate AS (
        SELECT
            sibling."albumId",
            10.0 * LOG(
                SUM(
                    sibling.duration
                    * POWER(10.0, sibling."loudnessLufs" / 10.0)
                ) / NULLIF(SUM(sibling.duration), 0)
            ) AS "albumLoudnessLufs",
            MAX(sibling."truePeakDb") AS "albumTruePeakDb"
        FROM "Track" AS sibling
        JOIN saved_album ON saved_album."albumId" = sibling."albumId"
        WHERE sibling."removedAt" IS NULL
        AND sibling."loudnessLufs" IS NOT NULL
        AND sibling.duration > 0
        GROUP BY sibling."albumId"
    )
    UPDATE "Album" AS album
    SET "albumLoudnessLufs" = aggregate."albumLoudnessLufs",
        "albumTruePeakDb" = aggregate."albumTruePeakDb"
    FROM saved_album
    LEFT JOIN aggregate ON aggregate."albumId" = saved_album."albumId"
    WHERE album.id = saved_album."albumId"
"""


def resolve_loudness_timeout_seconds() -> int:
    """Return the environment override clamped to an absolute safe range."""
    raw_value = os.getenv(
        "LOUDNESS_MEASURE_TIMEOUT_SECONDS",
        str(DEFAULT_LOUDNESS_TIMEOUT_SECONDS),
    )
    try:
        configured = int(raw_value)
    except ValueError:
        logger.warning(
            "Invalid LOUDNESS_MEASURE_TIMEOUT_SECONDS; using %s seconds",
            DEFAULT_LOUDNESS_TIMEOUT_SECONDS,
        )
        return DEFAULT_LOUDNESS_TIMEOUT_SECONDS
    return max(
        MIN_LOUDNESS_TIMEOUT_SECONDS,
        min(MAX_LOUDNESS_TIMEOUT_SECONDS, configured),
    )


LOUDNESS_MEASURE_TIMEOUT_SECONDS = resolve_loudness_timeout_seconds()


def _parse_bounded_float(value: object, minimum: float, maximum: float) -> float | None:
    """Parse one finite numeric value inside an inclusive sanity range."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or not minimum <= parsed <= maximum:
        return None
    return parsed


def parse_loudnorm_output(output: str) -> LoudnessMeasurement | None:
    """Parse the trailing JSON summary emitted by ffmpeg's loudnorm filter."""
    closing_brace = output.rfind("}")
    if closing_brace < 0:
        return None
    opening_brace = output.rfind("{", 0, closing_brace)
    if opening_brace < 0:
        return None
    try:
        parsed: object = json.loads(output[opening_brace : closing_brace + 1])
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None
    integrated = _parse_bounded_float(
        parsed.get("input_i"),
        MIN_LOUDNESS_LUFS,
        MAX_LOUDNESS_LUFS,
    )
    true_peak = _parse_bounded_float(
        parsed.get("input_tp"),
        MIN_TRUE_PEAK_DB,
        MAX_TRUE_PEAK_DB,
    )
    if integrated is None or true_peak is None:
        return None
    return {"loudnessLufs": integrated, "truePeakDb": true_peak}


def measure_loudness_for_backfill(
    file_path: str,
    timeout_seconds: int,
) -> LoudnessMeasurementResult:
    """Measure audio and classify content failures separately from infrastructure."""
    try:
        if isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, int):
            raise ValueError("timeout_seconds must be an integer")
        bounded_timeout = max(
            MIN_LOUDNESS_TIMEOUT_SECONDS,
            min(MAX_LOUDNESS_TIMEOUT_SECONDS, timeout_seconds),
        )
        ffmpeg_path = shutil.which("ffmpeg")
        if ffmpeg_path is None:
            logger.warning("ffmpeg is unavailable for loudness measurement")
            return {"measurement": None, "failure": "transient"}
        completed = subprocess.run(  # noqa: S603 -- fixed executable and arguments
            [
                ffmpeg_path,
                "-hide_banner",
                "-nostdin",
                "-nostats",
                "-i",
                file_path,
                "-af",
                "loudnorm=print_format=json",
                "-f",
                "null",
                "-",
            ],
            check=False,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            timeout=bounded_timeout,
        )
        if completed.returncode != 0:
            logger.warning(
                "ffmpeg loudness measurement failed with exit code %s",
                completed.returncode,
            )
            failure: LoudnessFailureClass = (
                "permanent" if os.path.exists(file_path) else "transient"
            )
            return {"measurement": None, "failure": failure}
        measurement = parse_loudnorm_output(f"{completed.stdout}\n{completed.stderr}")
        if measurement is None:
            logger.warning("ffmpeg loudness output did not contain valid EBU R128 values")
            return {"measurement": None, "failure": "permanent"}
        return {"measurement": measurement, "failure": None}
    except subprocess.TimeoutExpired:
        logger.warning(
            "ffmpeg loudness measurement timed out after %s seconds",
            timeout_seconds,
        )
        return {"measurement": None, "failure": "transient"}
    except Exception as error:  # The optional measurement must never fail track analysis.
        logger.warning("ffmpeg loudness measurement failed: %s", type(error).__name__)
        return {"measurement": None, "failure": "transient"}


def measure_loudness(
    file_path: str,
    timeout_seconds: int,
) -> LoudnessMeasurement | None:
    """Measure a complete native audio stream for ordinary analyzer work."""
    return measure_loudness_for_backfill(file_path, timeout_seconds)["measurement"]
