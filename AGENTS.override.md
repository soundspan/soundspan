# AGENTS.override.md - soundspan Local Addendum

This file is additive to `AGENTS.md` and does not replace canonical template content.
Use it for soundspan-specific deltas only.
If `AGENTS.replace.md` exists, replacement mode is active and this file should be ignored.

## Soundspan Deltas

- Canonical shared `.agents` root for this repo is `../agents-workfiles/soundspan` (resolved on this machine to `/home/joshd/git/agents-workfiles/soundspan`).
- `.agents/**` may be concurrently modified by other Codex sessions; every edit under `.agents/**` must be semantically merged against latest on-disk state before write.
- Prefer managed workflow commands:
  - `npm run agent:managed -- --mode sync`
  - `npm run agent:managed -- --mode check`
- When process expectations change in this repository, keep this local addendum in sync with canonical `AGENTS.md`.
