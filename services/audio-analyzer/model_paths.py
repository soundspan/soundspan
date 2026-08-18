"""Immutable paths for the analyzer's pre-packaged MusiCNN models."""

from __future__ import annotations

import os

MODEL_DIR = "/app/models"

MODELS = {
    "musicnn": os.path.join(MODEL_DIR, "msd-musicnn-1.pb"),
    "musicnn_metadata": os.path.join(MODEL_DIR, "msd-musicnn-1.json"),
    "mood_happy": os.path.join(MODEL_DIR, "mood_happy-msd-musicnn-1.pb"),
    "mood_sad": os.path.join(MODEL_DIR, "mood_sad-msd-musicnn-1.pb"),
    "mood_relaxed": os.path.join(MODEL_DIR, "mood_relaxed-msd-musicnn-1.pb"),
    "mood_aggressive": os.path.join(MODEL_DIR, "mood_aggressive-msd-musicnn-1.pb"),
    "mood_party": os.path.join(MODEL_DIR, "mood_party-msd-musicnn-1.pb"),
    "mood_acoustic": os.path.join(MODEL_DIR, "mood_acoustic-msd-musicnn-1.pb"),
    "mood_electronic": os.path.join(MODEL_DIR, "mood_electronic-msd-musicnn-1.pb"),
    "danceability": os.path.join(MODEL_DIR, "danceability-msd-musicnn-1.pb"),
    "voice_instrumental": os.path.join(MODEL_DIR, "voice_instrumental-msd-musicnn-1.pb"),
}
