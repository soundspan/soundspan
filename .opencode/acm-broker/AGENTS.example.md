# AGENTS.md

OpenCode-oriented companion example for a repo that uses `acm`.
Keep the real `AGENTS.md` at the repo root so OpenCode can inherit the project contract from the same place as other ACM operators. These companion docs should stay thin and map back to that file.

## Required Task Loop

See [.acm/acm-work-loop.md](.acm/acm-work-loop.md) for the full ACM command reference (CLI and MCP).

## OpenCode usage notes

- OpenCode is a primary ACM operator, not only a review backend.
- Use native repo search and file reads normally; ACM supplies durable state, rules, review history, and governed closeout.
- This repo's documented OpenCode support is explicit and repo-local: companion docs under `.opencode/acm-broker/` plus normal CLI or MCP access.
- If governed file scope expands beyond the initial receipt, declare the later-discovered files through `work.plan.discovered_paths` before relying on `review` or `done`.
- If you need to resume archived work, use `acm history` and then `acm fetch` the returned `fetch_keys`.
- If a planned task or review gate becomes obsolete, mark it `superseded` instead of leaving it open or `blocked`.

## Working rules

- Prefer small, reviewable changes over broad cleanup.
- Do not silently widen governed file scope.
- Do not invent product requirements, compatibility guarantees, or migration behavior the repo does not define.
- Keep durable work state current when you pause, hand off, or hit a blocker.
