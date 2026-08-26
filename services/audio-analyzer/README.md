# Audio Analyzer

The audio analyzer consumes local track jobs and persists MusicCNN/Essentia
features, EBU R128 loudness, and Chromaprint fingerprints.

Fingerprinting uses the image-provided `fpcalc` binary. It is silently optional
at runtime: a missing binary logs one warning and does not fail track analysis.
Every computed fingerprint is stored before any external lookup, so later
AcoustID passes do not decode audio again.

Set `ACOUSTID_API_KEY` to enable claim-based AcoustID lookups. The worker limits
requests to three per second, uses bounded timeouts and retries, and stores a
MusicBrainz recording and release-group identity only at score `0.70` or higher.
Without a key, lookup stays disabled and local fingerprint computation continues.

Run the CI-equivalent unit suite from the repository root:

```bash
pytest services/audio-analyzer/tests -q
```
