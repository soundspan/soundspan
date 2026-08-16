# Pluggable Vibe Embedding Provider

Spec drafted 2026-08-16 for [issue #537](https://github.com/soundspan/soundspan/issues/537). Status: accepted design, implementation not started. Decision record: keep the LAION-CLAP `music_audioset` 512-dimension embedding space; adopt DCLAP's distilled ONNX student as the default provider; formalize provider and embedding-space abstractions so future model changes are operational rollouts, not schema migrations.

Related: cross-peer taste vectors in Blends ([issue #529](https://github.com/soundspan/soundspan/issues/529)) and federated discovery ([issue #530](https://github.com/soundspan/soundspan/issues/530)) depend on the space-identity contract defined here.

## Problem

Vibe similarity is hard-wired to one implementation: the `services/audio-analyzer-clap` sidecar loads the pip `laion-clap` package (torch, transformers, librosa) with the `music_audioset_epoch_15_esc_90.14.pt` checkpoint and writes 512-dimension vectors to pgvector. Three pressures:

1. **Runtime weight.** The torch stack produces a multi-gigabyte container and slow CPU inference. The deployment base is NAS boxes, Raspberry Pi-class machines, k8s on aging hardware — CPU-first, memory-constrained. Analysis throughput on that fleet is the binding constraint on library onboarding.
2. **Packaging staleness.** The pip `laion-clap` package is dormant (though CLAP-the-architecture is maintained in HF Transformers, and 2026 landscape research found no model that justifies leaving this embedding space — see the research record on issue #537).
3. **Model lock-in.** Vectors are meaningless outside their model's space. Today a model change means a drop-and-recreate migration (the `20260128100000_reduce_embedding_dimension` migration is the precedent) and silent invalidation of every stored embedding. Nothing prevents queries from mixing incompatible vectors beyond convention.

## Decision summary

| Question | Decision |
| --- | --- |
| Embedding space | Keep LAION-CLAP `music_audioset`, 512-dim, cosine |
| Default provider | DCLAP distilled student, ONNX Runtime, CPU-first |
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
                                                    preprocessing, revision }
```

Rules:

- **Text and audio towers travel together.** A provider must serve both from the same joint space, or declare itself audio-only (in which case text→music search is disabled for that space — surfaced in settings, not silently degraded). The default and compat providers both serve text.
- The backend addresses providers by configured base URL (`VIBE_PROVIDER_URL`), following the existing sidecar patterns: internal-network only, bounded timeouts, health endpoint, the analyzer queue's admission and retry semantics unchanged.
- Vector normalization (L2) and dimension are asserted at the trust boundary on every response; mismatch against the active space is a hard job failure, never a stored vector.

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

- **Exactly one `active` space** serves all similarity queries, radio, mixes, Discover Weekly, and text search. Queries never cross spaces.
- One ANN index per space (partial index on `spaceId`), created when a space enters `migrating`, dropped when `retired`.
- Text queries encode through the active space's text tower — the backend requests `/v1/embed/text` from the provider bound to the active space, never a mismatched provider.
- Cross-peer vector exchange (Blends, federated discovery) transmits `(spaceId identity tuple, vector)`; peers compare identity tuples and only consume vectors whose space matches their own active space. Mismatch downgrades cross-peer features to metadata-level gracefully.

### Space migration (blue/green for vectors)

1. Register new space as `migrating`; new provider deployed alongside.
2. Background re-embed via the existing analyzer queue at low priority: oldest-first, resumable, progress surfaced on the Library Health dashboard ([issue #532](https://github.com/soundspan/soundspan/issues/532)) and the metrics registry (gauge: per-space coverage).
3. Cutover when coverage crosses threshold (default 95%): new space becomes `active`, remaining tail re-embeds opportunistically, old space enters `retired` grace (queries pinned to new space immediately).
4. Retirement drops old vectors and index after a configurable grace window.

Rollback before cutover is free (delete migrating space). Rollback after cutover re-activates the retired space if still in grace.

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

### Gate 2 — mixed-space recall validation

Distillation approximates the teacher. Existing libraries hold teacher vectors; the student claims the same space. Before the student may write into the teacher's space:

- Sample N tracks (target ≥1,000 across genres) from a real library; embed with both towers; measure (a) teacher-vs-student cosine per track, (b) top-k neighbor overlap querying teacher-indexed vectors with student query vectors, (c) text-query result overlap.
- Acceptance: defined thresholds (proposed: median cosine ≥ 0.98, top-10 overlap ≥ 0.9) recorded with the results in this document when run.
- **Pass** → student registers with the same space identity; no re-embedding; mixed vectors permitted.
- **Fail** → student registers as a distinct space and enters the migration flow above. The 5-6x speedup makes full re-embed tractable on the constrained fleet; this is the fallback, not a blocker.

## Rollout phases

1. **Registry + interface** (no behavior change): space table, spaceId on embeddings backfilled from `model_version`, provider HTTP contract extracted over the existing torch sidecar (it becomes Provider 2 in place).
2. **DCLAP student sidecar** behind `VIBE_PROVIDER_URL`, default-off; Gate 1 decision executed; Gate 2 validation run and recorded here.
3. **Default flip** per Gate 2 outcome (same-space adoption or migration cutover); torch sidecar remains available as compat/GPU choice; compose/Helm defaults updated; UPGRADING notes.
4. **Later**: MuQ-MuLan provider (new space, GPU) and hosted tags-level adapters, each their own issue.

## Non-goals

- Replacing the essentia analyzer (BPM/energy/mood) — complementary, unchanged.
- Multi-space simultaneous serving beyond migration grace.
- Browser-side embedding of any kind.

## Open questions

- Student text tower: DCLAP reuses the original CLAP text tower in ONNX — confirm its exported text tower hashes to the same weights as ours before sharing space identity.
- ANN index parameters per space (`lists` scales with row count) — recompute at cutover rather than inheriting.
- Whether provider `/v1/space` should be signed/attested for federation-facing trust, or whether peer space comparison by identity tuple suffices (current position: tuple suffices; vectors are opt-in shared already).
