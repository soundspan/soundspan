# Natural-Language Music Control (Local LLM)

Spec drafted 2026-08-16 for [issue #528](https://github.com/soundspan/soundspan/issues/528). Status: design phase. Principle: the model **compiles intent; it never picks songs and never mutates state**. Taste quality comes from the existing embedding/query machinery; the LLM only translates language into it.

## Problem

The query surface (text→music embedding search, filters, mix parameters, energy curves) is powerful but only reachable through UI affordances. "Rainy Sunday, nothing I've played this month, build toward energy" is expressible in the primitives today — there is just no way to say it.

## Provider configuration

- `LLM_BASE_URL`, `LLM_API_KEY` (optional), `LLM_MODEL` — OpenAI-compatible chat completions; covers LM Studio, Ollama, vLLM, llama.cpp server, and hosted endpoints with one client. Absent `LLM_BASE_URL` ⇒ every surface hidden; zero behavioral difference from today.
- Backend-only calls (never browser); bounded per the external-work rules: request timeout (default 30 s), no automatic retry inside a user-facing request, one in-flight compilation per user, rate-limited alongside the other abuse-control limiters (Redis-shared).
- Health probe on settings save (one tiny completion) so misconfiguration surfaces immediately, not on first use.

## The compilation contract (trust boundary)

The model receives a single tool schema `compile_playlist_plan` describing the query surface and must return one call:

```
{
  seedText?: string            // -> CLAP text-tower embedding query
  filters?: {
    genresAny?, genresNone?, yearRange?,
    excludePlayedWithinDays?, minPlayCount?, likedOnly?,
    artistsAny?, artistsNone?
  }
  audio?: { energyRange?, bpmRange? }
  shape?: { targetLength?, energyCurve?: "flat"|"rise"|"fall"|"arc",
            artistCap?, ordering?: "similarity"|"shuffled"|"curve" }
  title?: string
}
```

- **Zod-validated**; unknown fields rejected; every enum/range clamped server-side to the same bounds the UI enforces. Validation failure ⇒ one repair round-trip (schema + error returned to the model), then graceful "couldn't parse that — try rephrasing" with tappable example prompts. Never a silent fallback playlist.
- Execution maps plan → existing services (embedding search, programmatic-playlist toolkit, artist caps, energy curve via stored analyzer data). **No SQL, no identifiers, no free-form execution derived from model output.** The schema is the entire capability ceiling.
- **Injection stance:** track/artist names inside prompts (e.g., "more like Album X") are untrusted text; because the only tool is the read-only plan above, injected instructions can at worst shape a playlist. Invariant to preserve forever: this feature never gains a state-mutating tool. Recorded as a hard rule, tested by a guard that the tool registry contains exactly one read-only entry.

## Surfaces

1. **Playlist builder prompt** ("Describe it") → compiled plan → preview with the plan rendered as human-readable chips (the filters it understood — transparency doubles as debugging) → save.
2. **Saved plans are living**: a generated playlist stores `{prompt, compiledPlan, spaceId}` and can refresh on demand or schedule — natural-language smart playlists. Refresh re-executes the stored plan (no LLM call unless the user edits the prompt); embedding queries re-encode seedText only if the active embedding space changed (space contract from `vibe-embedding-provider.md`).
3. **"Why this pick"** on Discover Weekly/radio items: the recommendation pipeline already knows its reasons (similarity contributors, genre/tag matches, play-history signals). A template assembles the factual skeleton; the LLM only rewrites it conversationally. **Facts from the pipeline, phrasing from the model** — with the template-only version as the no-LLM fallback, so explanations ship even without a configured model.
4. **Naming/描述 suggestions** for any playlist (cheapest surface, good first ship).

## Model-quality reality

Small local models will emit invalid plans. Mitigations: the single-tool schema (no tool choice to get wrong), one repair round, low temperature default, canned example prompts in the UI, and a settings-page "test a prompt" box showing the compiled chips. Quality floor is honest: parsing quality varies by model; taste quality does not (it never depends on the model).

## Rollout and testing

1. Naming/descriptions → 2. playlist builder + saved plans → 3. explanations.
- Tests: schema validation fixtures (valid/invalid/hostile plans incl. injection-shaped strings); plan-execution mapping against mocked services; repair-round behavior; guard test pinning the read-only tool registry; zero-config invisibility test.
- Metrics: compilation success/repair/fail counters; latency histogram (bounded).

## Non-goals

- Model-side song selection, conversational agents with memory, voice, or any write-capable tool.
- Bundling or recommending specific models beyond documented setup examples (LM Studio, Ollama).

## Open questions

- Whether scheduled refresh of saved plans should re-prompt the LLM when the prompt text is unchanged (current position: no — determinism and zero idle LLM load win).
- Prompt-library sharing between users on an instance (nice social touch; defer to the social wave).
