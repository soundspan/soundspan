# Maintainer Docs

This directory is for tracked maintainer-only guidance that still has ongoing value after AWM onboarding.

- `LOGGING_STANDARDS.md` documents the current shared logging expectations for frontend, backend, and Python sidecars.
- `RELEASE_NOTES_TEMPLATE.md` is consumed by `scripts/release/generate-notes.mjs` and guarded by a blocking release-helper test.
- `scripts/release/*.mjs` contains the tracked release-prep, chart-sync, and release-notes helpers that were kept because they are still operationally useful outside AWM.

These docs are not part of the AWM control plane. Treat
`LOGGING_STANDARDS.md` as human reference material, not a machine-enforced
contract.
