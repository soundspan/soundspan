# Repository Indexing and Vectorization

This guide documents the local indexing subsystem used to keep retrieval fast while keeping LLM context small.

## Goals

1. Fast local retrieval over source + docs without indexing noisy artifacts.
2. Deterministic vectorization (no remote embedding drift).
3. Incremental rebuilds based on content hashes.
4. Explicit integrity verification and source-drift detection.
5. Operationally simple: one config file and three commands.

## Commands

Run from repository root:

```bash
npm run index:build
npm run index:query -- "social presence route"
npm run index:verify
```

Additional options:

```bash
# Force full rebuild (ignore reuse)
npm run index:rebuild

# Query with custom result count
npm run index:query -- "listen together socket state" --top 12

# JSON output for automation
node tools/index/indexer.mjs query "playback state route" --json

# Strict freshness gate (fail if git/index drift exists)
node tools/index/indexer.mjs query "openrouter config" --strict-fresh
```

## Agent Preflight Integration

- `npm run agent:preflight` includes an index-readiness gate for the active branch/worktree namespace.
- If the namespaced index is missing, preflight builds it before continuing.
- If the namespaced index exists, preflight runs strict verify before implementation work begins.
- At task closeout (when feasible), run `npm run index:verify`; if drift is reported, run `npm run index:build` and verify again.

## Files and Locations

Implementation files:

- `tools/index/indexer.mjs`
- `tools/index/index.config.json`

Generated index artifacts (local-only):

- `.agents/index/soundspan-v1/<namespace>/manifest.json`
- `.agents/index/soundspan-v1/<namespace>/files.jsonl`
- `.agents/index/soundspan-v1/<namespace>/chunks.jsonl`
- `.agents/index/soundspan-v1/<namespace>/symbols.jsonl`
- `.agents/index/soundspan-v1/<namespace>/vectors.f32`

The output directory defaults to `.agents/index/soundspan-v1` and can be overridden with `--output`.

## Branch and Worktree Isolation

By default, the index is isolated by both current branch and worktree identity.

- Config: `tools/index/index.config.json` (`isolation.mode: "branch-worktree"`)
- Effective namespace format: `br-<branch-slug>--wt-<worktree-hash>`
- Effective output path:
  - `.agents/index/soundspan-v1/br-<branch-slug>--wt-<worktree-hash>/...`

This prevents collisions when:

1. Two worktrees build index artifacts for the same branch.
2. One worktree switches branches and each branch needs a separate index state.

`--output <dir>` bypasses default isolation and writes directly to the specified path.

## Data Model

### `files.jsonl`

Per indexed file metadata:

- `path`, `area`, `language`
- `hash` (SHA-256 of full file content)
- `mtime_ms`, `size_bytes`
- import/export/route-hint summaries
- `indexed_via` (`reused` or `rebuilt`)

### `chunks.jsonl`

Per retrieval chunk:

- `path`, `start_line`, `end_line`
- `chunk_type` (`doc`, `symbol`, `code`, `text`, etc.)
- `symbol_name` + `symbol_kind` when available
- `text` and `text_hash`
- `file_hash`
- `vector_row` (row offset into `vectors.f32`)
- `area_weight` (path-priority prior)

### `symbols.jsonl`

Structural index:

- symbol `name`, `kind`, `start_line`, `end_line`
- `signature` (trimmed source line)
- `id`, `file_hash`, `path`

### `vectors.f32`

Row-major float32 matrix. Row `i` corresponds to chunk with `vector_row: i`.

### `manifest.json`

Build contract and drift guard:

- engine identity/version/dimension
- config hash
- git head/dirty capture at build time
- stats and artifact checksums
- drift contract flags

## Chunking Strategy

### Code files

1. Extract symbols (functions/classes/interfaces/types/constants/routes).
2. Build symbol-bounded regions.
3. Split large regions into overlapping windows (`codeMaxLines`, `codeOverlapLines`).
4. Preserve pre-symbol preamble as its own chunk when present.

### Markdown/docs

1. Split by heading sections.
2. Apply overlapping line windows (`docMaxLines`, `docOverlapLines`) for long sections.

### Generic text

Sliding windows with `textMaxLines` and `textOverlapLines`.

## Vectorization Strategy (Deterministic)

Engine: `deterministic-hash-tf`.

Pipeline:

1. Normalize text (lowercase, punctuation normalized, camelCase split).
2. Tokenize (`[a-z0-9_/-]{2,64}`), drop stop words and numeric-only tokens.
3. Add bounded bigram features.
4. Hash tokens via FNV-1a into fixed dimension (`384` by default).
5. Build term-frequency weights (`1 + log(tf)`).
6. L2 normalize vector.

Why this is drift-averse:

- No external model/provider calls.
- No model version volatility.
- Same input + config always yields identical vectors.
- Incremental reuse of unchanged chunk vectors is exact.

## Query Strategy

Hybrid ranking:

1. Vector similarity (cosine on normalized vectors).
2. Lexical signal (query-token presence in chunk/path/symbol).
3. Symbol match boosts.
4. Path/area prior.
5. Recency prior (file mtime range normalization).

Default scoring weights are configurable in `tools/index/index.config.json`.

## Incremental Rebuild Semantics

`build` mode reuses prior file chunks/vectors only when all are true:

1. Existing index exists and is valid.
2. Config hash matches previous build.
3. Engine identity/version/dimension match.
4. File content hash is unchanged.

Otherwise the file is rebuilt.

`index:rebuild` forces full regeneration.

## Drift and Integrity Controls

### Integrity (`verify`)

Checks:

1. Required artifact presence.
2. Vector row count and matrix length consistency.
3. Manifest checksum matches for `files/chunks/symbols/vectors`.
4. Chunk-level `text_hash` verification.
5. File/chunk hash linkage validation.
6. Symbol/file linkage validation.

### Source drift (`verify`)

For every indexed file:

1. Confirms file still exists.
2. Recomputes source hash.
3. Flags changed/missing files.

`--strict` converts drift warnings into failures.

### Git-state drift

Compares current `HEAD` and dirty state versus build-time manifest.

`query --strict-fresh` fails fast if git/index drift exists.

## Configuration Reference

`tools/index/index.config.json`:

- `includeRoots`: only these trees are scanned.
- `excludeGlobs`: hard excludes.
- `pruneDirectories`: recursive walk short-circuit.
- `extensions`: allowed file suffixes.
- `chunking`: line/window limits and max file size.
- `engine.dimension`: vector dimension.
- `query.weights`: ranking mix.
- `areaWeights`: path priors.
- `isolation.mode`: output isolation mode (`branch-worktree` or `none`).
- `isolation.worktreeHashLength`: namespace hash length for worktree identity.

## Operational Playbooks

### Daily usage

1. Run `npm run index:build` after pulling/merging substantial changes.
2. Run `npm run index:verify` before relying on high-precision retrieval.
3. Query via `npm run index:query -- "<question>"`.

### CI/automation

Recommended gates:

1. Build index.
2. Verify with `--strict`.
3. Optionally store only manifest + verify summary (not full vectors) for logs.

### Incident response (bad results)

1. `npm run index:verify` to confirm integrity.
2. If drifted, rebuild with `npm run index:rebuild`.
3. Validate with a known query.
4. If still weak, tune:
   - `includeRoots`
   - chunk window sizes
   - query weights
   - area priors

## Known Limits

1. Heuristic symbol extraction (regex-based), not full AST parsing.
2. Deterministic hashing vectors trade semantic nuance for reproducibility.
3. Query-time lexical prefilter is linear over chunk text.

These limits are intentional to prioritize determinism, local operation, and low maintenance.

## Upgrade and Compatibility Notes

When changing index format/fields:

1. Bump `indexFormatVersion` in config.
2. Rebuild full index.
3. Update this document for schema/contract changes.

When changing vector engine behavior:

1. Bump `engine.version`.
2. Run full rebuild.
3. Keep old artifacts isolated by output path/version if side-by-side comparison is required.
