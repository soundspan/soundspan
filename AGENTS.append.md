# AGENTS.append.md - soundspan Local Addendum

This file is additive to `AGENTS.md` and should contain soundspan-specific deltas only.

## Soundspan Deltas

- Canonical shared `.agents` root for this repo is `../agents-workfiles/soundspan` (resolved on this machine to `/home/joshd/git/agents-workfiles/soundspan`).
- `.agents/**` may be concurrently modified by other Codex sessions; every edit under `.agents/**` must be semantically merged against latest on-disk state before write.
- Prefer full template sync/fix/verify with:
  - `npm run agent:sync`
- Optional remote-template mode (only when the selected template ref is published remotely):
  - `npm run agent:sync -- --prefer-remote`
- Use managed-only repair when template source/ref and profiles are already correct:
  - `npm run agent:managed -- --fix --recheck`
- Use bootstrap directly only for explicit profile/template-source reconfiguration that is not yet represented in `.agents-config/agent-managed.json`.
