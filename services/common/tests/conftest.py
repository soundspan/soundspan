"""Expose the shared service package under its runtime import name."""

from __future__ import annotations

import sys
from pathlib import Path

SERVICES_ROOT = Path(__file__).resolve().parents[2]

if str(SERVICES_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICES_ROOT))
