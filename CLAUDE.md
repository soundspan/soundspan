# CLAUDE.md

Claude companion for soundspan. The primary contract is `AGENTS.md` — if this file conflicts, `AGENTS.md` wins.

If AWM is available in your session, also follow [.awm/AGENTS-AWM.md](.awm/AGENTS-AWM.md).

## Source Of Truth

- `AGENTS.md` is the full repo contract.
- Claude assets (created by the reinstall command below; `.claude/` is local-only, not tracked): `.claude/commands/`, `.claude/awm-broker/`
- Reinstall command pack: `bash <(curl -fsSL https://raw.githubusercontent.com/bonztm/agent-workflow-manager/main/scripts/install-skill-pack.sh) --claude`
