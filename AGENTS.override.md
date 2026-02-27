# AGENTS.override.md - soundspan Local Addendum

This file is additive to `AGENTS.md` and does not replace canonical template content.
Use it for soundspan-specific deltas only.
If `AGENTS.replace.md` exists, replacement mode is active and this file should be ignored.

## Soundspan Deltas

- Canonical shared `.agents` root for this repo is `../agents-workfiles/soundspan` (resolved on this machine to `/home/joshd/git/agents-workfiles/soundspan`).
- `.agents/**` may be concurrently modified by other Codex sessions; every edit under `.agents/**` must be semantically merged against latest on-disk state before write.
- Prefer managed workflow commands:
  - `npm run agent:managed -- --mode check`
  - `npm run agent:managed -- --fix --recheck --prefer-remote`
- Bootstrap sync command for this repo:

```bash
npm run bootstrap -- \
  --mode existing \
  --target-path . \
  --project-id "$PROJECT_ID" \
  --profiles base,node-web \
  --template-ref "$TEMPLATE_REF"
```

- Use `bootstrap` when:
  1. You are moving to a new `--template-ref`.
  2. The template added or removed managed files.
  3. Profiles changed (`base`, `node-web`, etc.).
  4. You want template script/dependency/managed-manifest updates pulled in.
- Use `agent:managed -- --fix --recheck` when:
  1. The correct manifest and template ref are already present locally.
  2. You only need to repair managed drift and re-verify.
- When process expectations change in this repository, keep this local addendum in sync with canonical `AGENTS.md`.
