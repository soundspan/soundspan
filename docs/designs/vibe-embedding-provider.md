# Pluggable Vibe Embedding Provider

Spec drafted 2026-08-16 for [issue #537](https://github.com/soundspan/soundspan/issues/537). Status: accepted design; rollout phase 1 and the blue/green migration machinery are implemented by migrations `20260816120000_add_embedding_space_registry` and `20260816130000_add_embedding_space_migration`; the backend provider client and the torch CLAP provider contract have landed; backend-driven audio embedding is available behind `VIBE_PROVIDER_URL`; and the DCLAP ONNX sidecar ships default-off under an opt-in Compose profile. Upstream DCLAP validation measured approximately 0.88 student-to-teacher fidelity. The 2026-08-17 Gate 2 run confirmed the distinct `clap-music-audioset-dclap-student` space and selected the migration path for adoption; the default-provider flip remains a maintainer decision. Decision record: keep the LAION-CLAP `music_audioset` 512-dimension space active until cutover; adopt DCLAP's distilled ONNX student as the default provider through a full re-embed; formalize provider and embedding-space abstractions so future model changes are operational rollouts, not schema migrations.

Related: cross-peer taste vectors in Blends ([issue #529](https://github.com/soundspan/soundspan/issues/529)) and federated discovery ([issue #530](https://github.com/soundspan/soundspan/issues/530)) depend on the space-identity contract defined here.

## Problem

Vibe similarity is hard-wired to one implementation: the `services/audio-analyzer-clap` sidecar loads the pip `laion-clap` package (torch, transformers, librosa) with the `music_audioset_epoch_15_esc_90.14.pt` checkpoint and writes 512-dimension vectors to pgvector. Three pressures:

1. **Runtime weight.** The torch stack produces a multi-gigabyte container and slow CPU inference. The deployment base is NAS boxes, Raspberry Pi-class machines, k8s on aging hardware — CPU-first, memory-constrained. Analysis throughput on that fleet is the binding constraint on library onboarding.
2. **Packaging staleness.** The pip `laion-clap` package is dormant (though CLAP-the-architecture is maintained in HF Transformers, and 2026 landscape research found no model that justifies leaving this embedding space — see the research record on issue #537).
3. **Model lock-in.** Vectors are meaningless outside their model's space. Today a model change means a drop-and-recreate migration (the `20260128100000_reduce_embedding_dimension` migration is the precedent) and silent invalidation of every stored embedding. Nothing prevents queries from mixing incompatible vectors beyond convention.

## Decision summary

| Question | Decision |
| --- | --- |
| Embedding space | Keep LAION-CLAP `music_audioset`, 512-dim, cosine; DCLAP advertises a distinct student identity |
| Planned default provider | DCLAP distilled student, ONNX Runtime, CPU-first; shipped default-off pending later wiring |
| Compat/GPU provider | Current torch `laion-clap` sidecar, unchanged |
| Future providers | MuQ-MuLan (GPU, new space, NC-weights caveat); hosted tags-level adapters only — never embedding-level primaries |
| Space changes | Versioned space registry with background re-embed and threshold cutover |

## Provider interface

A provider is a sidecar (or external endpoint) implementing three operations behind one HTTP contract, plus identity metadata:

```
POST /v1/embed/audio    { trackRef | upload }  -> { vector: float[dim] }
POST /v1/embed/text     { text }               -> { vector: float[dim] }
GET  /v1/space                                  -> { family, checkpointHash,
                                                    dim, sampleRateHz,
                                                    preprocessing, revision,
                                                    textTower }
```

Rules:

- **Text and audio towers travel together.** A provider must serve both from the same joint space, or declare itself audio-only (in which case text→music search is disabled for that space — surfaced in settings, not silently degraded). The default and compat providers both serve text.
- The backend addresses providers by configured base URL (`VIBE_PROVIDER_URL`), following the existing sidecar patterns: internal-network only, bounded timeouts, health endpoint, the analyzer queue's admission and retry semantics unchanged.
- Vector normalization (L2) and dimension are asserted at the trust boundary on every response; worker writes are also dimension-checked against their resolved target registry row, and a mismatch is a hard job failure rather than a stored vector.

## Embedding-space registry

The half-built hook becomes a real contract. The existing `model_version VARCHAR(50)` column (default `'laion-clap-music'`) is superseded by a registry table:

```
EmbeddingSpace {
  id            cuid
  family        text      // "clap-music-audioset"
  checkpointHash text     // content hash of weights
  dim           int
  preprocessing json      // sample rate, mel config, mono/stereo policy
  status        enum      // active | migrating | retired
  createdAt     timestamp
}
TrackEmbedding.spaceId -> EmbeddingSpace.id   // replaces model_version
```

Invariants:

- **Exactly one `active` space** serves all similarity queries, radio, mixes, Discover Weekly, and text search. Outside the bounded cutover cache window documented below, queries never cross spaces.
- The existing global ANN index continues to serve the active space. A partial ANN index for a migrating space is created immediately before cutover and dropped after that space is later retired and cleaned.
- In steady state, text queries encode through the active space's text tower. During migration, the backend uses the fallback and bounded cutover behavior documented below instead of requesting `/v1/embed/text` from a provider whose space is not active.
- Cross-peer vector exchange (Blends, federated discovery) transmits `(spaceId identity tuple, vector)`; peers compare identity tuples and only consume vectors whose space matches their own active space. Mismatch downgrades cross-peer features to metadata-level gracefully.

### Space migration (blue/green for vectors)

1. Set `VIBE_PROVIDER_URL` on the worker to the new provider and restart it. The worker reads `/v1/space`; an unknown `(family, checkpointHash)` tuple is registered automatically as `migrating`.
2. The enrichment producer queues eligible local tracks missing that target-space vector. The same queue remains bounded and resumable, and the coverage gauge reads the worker target space.
3. When coverage reaches `VIBE_SPACE_CUTOVER_THRESHOLD` (default 95%), the worker builds the target's partial ANN index, atomically marks the old space `retired` and the target `active`, then invalidates the active-space cache.
4. The old vectors remain available for `VIBE_SPACE_RETIREMENT_GRACE_DAYS` (default 7). The worker then deletes them in bounded batches, drops their partial index if present, clears the grace anchor to mark cleanup complete, and retains the registry identity row as history.

When the active space contains zero vectors, the worker builds the target's partial ANN index and cuts over immediately without waiting for migration coverage. A fresh install may never deploy the teacher worker, and an empty active space protects no query results, so this closes the provider-only text-search dead window without sacrificing existing similarity results.

Keep the torch CLAP sidecar and its Redis text-embedding handler running throughout a migration. While the configured provider's space is not active, text search falls back to that legacy text tower so queries remain in the active space. `CLAP_WORKERS=0` disables its audio workers without stopping the text handler.

At the cutover boundary, a cached provider-space mismatch can keep text search on the legacy tower while ANN reads use the new active space for at most 60 seconds. This bounded cross-space window equals the provider/active-space verdict-cache TTL. The next verdict refresh sees that the configured provider now matches the active space and moves text encoding to that provider without operator action.

Migration exposes two intentional operational lenses. The vibe embedding coverage gauge measures the migrating worker target so operators can assess cutover readiness. Enrichment progress and feature detection continue to measure the active space because they describe the vectors currently serving user queries.

Tracks added while a migration is running receive only the migrating-space vector. They become available to active-space similarity features at cutover; the worker does not also write the old active space during the migration.

The producer and claim gate continuously admit `null`, `pending`, or `completed` tracks that lack a vector in the worker's target space. This automatically heals migration and post-cutover tails. `POST /api/analysis/vibe/start` remains available as a break-glass way to enqueue missing active-space vectors immediately, but normal tail recovery does not require it.

To abort before cutover, delete the migrating space's vectors first, then delete its registry row; `ON DELETE RESTRICT` enforces that order. To roll back after cutover but within grace, atomically return the new space to `migrating` or `retired` and restore the prior retired space to `active`. This release does not add an administration endpoint for either operation.

## Default provider: DCLAP student (ONNX)

7M-parameter distilled audio tower + the original CLAP text tower, both ONNX, no torch. Expected effects: container shrinks from multi-GB to ONNX-runtime scale; 5-6x CPU inference speedup (upstream benchmark: Raspberry Pi 5); analysis throughput stops being the onboarding bottleneck on the majority fleet.

### Gate 1 — license and distribution posture

DCLAP is AGPL-3.0; soundspan is GPL-3.0. As a separately-distributed networked sidecar this composes cleanly. The design requires an explicit distribution mode decision, one of:

| Mode | Compliance posture | Operator experience |
| --- | --- | --- |
| (a) Reference upstream's published image | Cleanest — we distribute nothing of theirs | Extra registry dependency; version pinning by digest |
| (b) Build our own sidecar image vendoring their ONNX weights | AGPL obligations attach to that image (source offer for the sidecar) — GPLv3 app unaffected | One registry, our build pipeline, our scanning |
| (c) Fetch weights on first start | No redistribution | Startup network dependency — conflicts with the offline-friendly self-hosting posture |

Recommendation: **(b)**, with the sidecar's repository/source offer documented, matching how the image pipeline already builds and scans sidecars. Alternative accepted outcome: in-house ONNX export of the exact teacher checkpoint (Apache-2.0 checkpoint, zero third-party code) if DCLAP vendoring proves awkward — same runtime win, slightly less speed, zero recall question.

**Executed 2026-08-16:** mode **(b)**. `services/vibe-provider-dclap` builds a project-owned image that vendors the three DCLAP v1 ONNX artifacts with pinned SHA-256 checks and vendors the teacher tokenizer from an immutable Hugging Face commit. The image includes the upstream AGPL-3.0 license and a notice linking both this sidecar's corresponding source and the upstream DCLAP source. The service remains an isolated HTTP-only process and is not included in the AIO image.

### Gate 2 — mixed-space recall validation

Distillation approximates the teacher. Existing libraries hold teacher vectors, so a student could claim the teacher space only after this gate:

- Sample N tracks (target ≥1,000 across genres) from a real library; embed with both towers; measure (a) teacher-vs-student cosine per track, (b) top-k neighbor overlap querying teacher-indexed vectors with student query vectors, (c) text-query result overlap.
- Acceptance: median cosine ≥ 0.98 and mean top-10 neighbor overlap ≥ 0.9, recorded with the results in this document when run.
- **Pass** → student registers with the same space identity; no re-embedding; mixed vectors permitted.
- **Fail** → student registers as a distinct space and enters the migration flow above. The 5-6x speedup makes full re-embed tractable on the constrained fleet; this is the fallback, not a blocker.

#### How to run

Prerequisites: start both provider sidecars with the same `INTERNAL_API_SECRET`, make the real local library and its persisted `filePath` references visible to both sidecars, and configure the backend database connection. Run from the repository root:

```bash
cd backend
npx tsx scripts/validateProviderFidelity.ts \
  --baseline-url http://audio-analyzer-clap:8091 \
  --candidate-url http://vibe-provider-dclap:8092 \
  --sample 1000 \
  --k 10 \
  --output ../provider-fidelity-report.md
```

`--baseline-url` may be omitted; it defaults to `VIBE_PROVIDER_URL` when configured, then to `http://audio-analyzer-clap:8091`. The candidate URL is always explicit. The tool uses the vocabulary artifact's term names for text queries, writes the Markdown path plus an adjacent JSON report, and never registers a provider or mutates library data.

The audio comparison is cosine `a·b / (||a|| ||b||)` for each paired track. Neighbor recall is `|topK(A query, A index) ∩ topK(B query, A index)| / k`, excluding the query track. Text-query recall uses the same overlap formula against the baseline audio index. The gate uses inclusive comparisons: median paired cosine `>= 0.98` and mean top-10 neighbor overlap `>= 0.9`.

#### Results

Record real-library runs here when they happen. Do not replace the measured values with synthetic fixtures or upstream validation metrics.

| Run date | Library/sample | Baseline identity | Candidate identity | Median cosine | Mean top-k overlap | Mean text-query overlap | Verdict | Report |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- |
| 2026-08-17 | Production library; 50/50 valid; k=5; 0 exclusions; 753449 ms | `clap-music-audioset` / `fae3e9c087f2909c28a09dc31c8dfcdacbc42ba44c70e972b58c1bd1caf6dedd` / 512 | `clap-music-audioset-dclap-student` / `c892c7a8666dfa5adec5f0b76ecdd9b5394f5afa925d1362750309b6b9b96639` / 512 | 0.854375 | 0.668000 | 1.000000 | `distinct_space_required` | [Full report](gate2-report-2026-08-17.md) |

This real-library run used n=50, not the target n≥1,000. The operator deliberately chose the reduced sample and k=5. Chance-level top-5 overlap for a 50-track index is approximately 10%. The observed mean overlap of 0.668000 is far above chance but below the 0.900000 same-space bar. The 0.854375 median cosine also falls well below the 0.980000 bar, so the reduced sample size does not affect the verdict. The exclusion policy passed.

The perfect 1.000000 text-query overlap shows that the teacher-derived text tower remains intact in the student packaging: text queries against the baseline index rank identically. The audio tower remains a distillation approximation. The measured `distinct_space_required` verdict confirms the shipped conservative default. The student remains the distinct `clap-music-audioset-dclap-student` space, and adoption uses the blue/green migration flow. No same-space claim is permitted.

## Rollout phases

1. **Registry + interface** (no behavior change): space table, spaceId on embeddings backfilled from `model_version`, provider HTTP contract extracted over the existing torch sidecar (it becomes Provider 2 in place).
2. **DCLAP student sidecar** shipped default-off under an opt-in Compose profile; Gate 1 mode (b) executed; distinct student space identity enforced (upstream fidelity approximately 0.88 selects the distinct-space migration path).
3. **Default flip** after the implemented blue/green backfill and automatic cutover; torch sidecar remains available as the compat/GPU choice; compose/Helm defaults and UPGRADING notes remain follow-up rollout work under the recorded Gate 2 distinct-space verdict.
4. **Later**: MuQ-MuLan provider (new space, GPU) and hosted tags-level adapters, each their own issue.

## Non-goals

- Replacing the essentia analyzer (BPM/energy/mood) — complementary, unchanged.
- Multi-space simultaneous serving beyond migration grace.
- Browser-side embedding of any kind.

## Open questions

- Student text tower: DCLAP reuses the original CLAP text tower in ONNX — confirm its exported text tower hashes to the same weights as ours before sharing space identity.
- ANN index tuning after initial rollout — the implemented cutover uses the established `lists = 224` setting and creates the partial index immediately before activation.
- Whether provider `/v1/space` should be signed/attested for federation-facing trust, or whether peer space comparison by identity tuple suffices (current position: tuple suffices; vectors are opt-in shared already).
