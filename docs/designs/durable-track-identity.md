# Durable Track Identity

Spec drafted 2026-08-14 for [issue #457](https://github.com/soundspan/soundspan/issues/457). Status: implemented, pending release. Phases 1 and 3 delivered durable keys plus move/replacement matching; phases 2a–2c delivered soft removal/revival, read-surface exclusion and retention purge, then frontend and admin visibility.

Spun out of the federated library sharing design ([issue #451](https://github.com/soundspan/soundspan/issues/451), `docs/designs/federated-library-sharing.md`) as a standalone prerequisite feature: it fixes a real local data-loss bug today and independently upgrades cross-source track matching from fuzzy to exact.

## Problem

A local track's identity is its file path, and nothing else.

- The scanner upserts on `where: { filePath }` (`backend/src/services/musicScanner.ts:1065`). `Track.filePath` is `@unique` and non-nullable.
- When a path disappears, `handleMissingTracks` **hard-deletes** the row (`prisma.track.deleteMany`, `musicScanner.ts:144`). There is no move detection: a rename or folder reorg is a delete + fresh insert with a new cuid.
- Local tracks carry no track-level content identity: no audio hash, no MusicBrainz recording ID, no ISRC, no fingerprint. (The scanner already reads *artist* mbid and *release-group* mbid from tags; it stops there.)

**Blast radius of a file move today** (verified against `backend/prisma/schema.prisma` relations on `Track`):

| Destroyed (`onDelete: Cascade`) | Orphaned (`onDelete: SetNull`) |
| --- | --- |
| `PlaylistItem` — playlist membership | `Play` — play history loses its track link |
| `LikedTrack` — likes | `TrackMapping` — Tidal/YT links dangle |
| `TrackEmbedding` — 512-dim CLAP vector (GPU re-analysis required) | `SyncGroup` current track |
| `TrackLyrics`, `MoodBucket`, `TrackGenre`, `Bookmark`, `TranscodedFile`, `CachedTrack`, `LibraryHealthRecord` | |

Retagging a library with MusicBrainz Picard — the tool this audience most likely uses — often *renames files as part of tagging*, so the act of improving your metadata silently destroys your playlists, likes, and analysis results.

Federation (#451) amplifies this on both sides: a host reorganizing files floods its delta feed with tombstone+re-add churn, and a consumer's matched links break with it.

## Goals

- A track keeps its `Track.id` (and everything hanging off it) across file moves, renames, and retags — including moves that span multiple scans (file disappears, comes back weeks later).
- Replacing a file in place with a higher-quality version is detected as a **replacement**: same identity, refreshed derived data (analysis, embedding, transcode cache).
- A removed track is recoverable: if the file (or an equivalent) ever returns, it picks up its old metadata, playlists, likes, and analysis again.
- Tracks gain durable identity columns usable for exact matching across sources (Tidal, YT Music, future federation peers).
- Zero behavior change for libraries where nothing moves; no new required dependencies (ffmpeg is already a runtime dependency of `AudioStreamingService`).

## Non-goals

- AcoustID/Chromaprint fingerprinting in v1 — designed for, deferred (see Phase 4).
- Deduplicating distinct local files that contain the same audio. Two files remain two tracks.
- Any federation-specific code. This feature is purely local; #451 builds on it.

## Design

### Identity model: content hash + path + tag keys, in strict precedence

**Primary content identity: an audio-stream hash.** Not a whole-file hash — tags live *inside* audio files (ID3, Vorbis comments, MP4 atoms), so a whole-file hash changes on every retag and would defeat the Picard retag-and-rename case. Instead, hash only the encoded audio packets, which survive any tag edit:

```
ffmpeg -i <file> -map 0:a:0 -c copy -f streamhash -   # e.g. "0,a,SHA256=..."
```

Demux-only (no decode), so it is I/O-bound like a plain byte hash. ffmpeg is already shipped for transcoding. Properties:

- **Retag / rename / move:** audio packets unchanged → hash unchanged → exact identity match.
- **Quality upgrade (re-rip, re-encode, mp3→flac):** audio packets differ → hash differs → correctly treated as *replacement*, never mistaken for the same bytes.
- **Untagged files:** hash works where tag-based keys can't.

Schema:

```prisma
model Track {
  // ...existing fields...
  audioHash     String?   // "sha256:<hex>" of the primary audio stream; indexed, NOT unique
  audioHashedAt DateTime? // when the hash was computed (staleness/backfill tracking)
  recordingMbid String?   // MusicBrainz recording ID from tags; indexed, NOT unique
  isrc          String?   // from tags; indexed, NOT unique
  removedAt     DateTime? // soft-delete marker; null = active. Indexed.
}
```

None of these are unique: legitimate duplicates exist (same file copied twice, same recording on album + compilation). They are match keys, not primary keys. The hash string embeds its algorithm (`sha256:`) so the scheme can evolve without a second column.

**Hash cost control.** The scanner never re-reads unchanged files: a hash is computed only when a file is new, or when its `fileSize`/`fileModified` differ from the stored row (the same change-detection the scanner already performs). Steady-state scans hash nothing. The initial backfill is one full-library read pass that populates `audioHash`, `recordingMbid`, and `isrc` — run as a bounded, resumable background job through the existing worker/queue pattern (`backend/src/workers/`), not inline in the first scan, so the first post-upgrade scan doesn't take hours. Until a row has `audioHash`, matching simply falls through to the tag tiers below.

### Precedence: path first, then content

The tension in any durable-identity scheme: identity by **location** (path) versus identity by **content** (hash/tags). Both replacement (same path, new content) and move (same content, new path) must preserve identity, and they pull in opposite directions. Resolution — strict precedence:

1. **A file present at a known `filePath` IS that track.** The existing upsert keyed on `filePath` stays authoritative; no content check may override a path match.
   - Same path, same `audioHash` → unchanged (or pure retag: refresh tag-derived metadata only).
   - Same path, **different non-null `audioHash`** → **replacement**: keep `Track.id`, update file fields + hash, re-queue audio analysis, CLAP embedding, and transcode-cache invalidation for that row. A hash failure leaves derived data intact because content identity is unknown: the stored hash is retained as the comparison baseline, and the backfill retries hashing later. This is the "upgraded file at the exact path" rule: identity survives, derived data refreshes. (Consequence, accepted: overwriting a path with a genuinely different recording keeps the old row's id. Path wins by design.)
2. **Content tiers arbitrate the leftovers.** Paths that disappeared this scan are matched against (a) paths that appeared this scan and (b) — thanks to soft delete — files that appear in *any future* scan, via the removed pool (below). First match wins:
   1. `audioHash` equal — exact, works for untagged files, immune to retags;
   2. `recordingMbid` equal (duration ignored — upgrades may change master);
   3. `isrc` equal (duration ignored);
   4. same album `rgMbid` + `discNo` + `trackNo` + normalized title, duration ±10s (wide — covers format upgrades of the same release, where the hash intentionally differs);
   5. same `fileSize` + duration ±2s + normalized title (tight — last resort for pure renames of untagged, unhashed files).

   On match: update `filePath`/`fileModified`/`fileSize`/`audioHash` in place, preserving `Track.id`. If both hashes are known and differ (moved *and* upgraded), apply the replacement rule's re-analysis as well. A null next hash is unknown and never triggers destructive reset behavior.

   Ambiguity rule: if a tier yields more than one candidate for a row, that tier abstains and the next runs; if all abstain, the row is treated as unmatched. Never guess between two candidates.
3. **Soft-remove what nothing claims.** Unmatched disappeared rows are marked `removedAt = now()` — never hard-deleted by the scanner (next section).

The quality-upgrade matrix this yields:

| Scenario | Path | Audio hash | Outcome |
| --- | --- | --- | --- |
| Replace `01 Song.flac` in place with a better rip | same | differs | Same row (rule 1) — replacement: id + playlists intact, analysis re-queued |
| Retag in place (Picard, no rename) | same | same | Same row — metadata refresh only |
| Rename/reorganize folders (Picard retag+rename) | changed | same | Hash tier match — id intact, analysis kept |
| Upgrade `01 Song.mp3` → `01 Song.flac` | changed | differs | Tag/position tiers match — id intact, analysis re-queued |
| Replace whole album folder, new filenames | changed | differs | Per-track recordingMbid / rgMbid+position — ids intact |
| File deleted, restored from backup next month | gone → back | same | Removed pool hash match on reappearance — full revival |
| Genuinely delete an album | gone | — | Soft-removed; purged after retention window |

### Soft delete and revival

The scanner stops hard-deleting. `handleMissingTracks` becomes `markRemovedTracks`: set `removedAt`, keep every relation intact. Nothing cascades, so playlists, likes, embeddings, lyrics, mood buckets, and play history all survive removal by construction.

**Revival.** During every scan, files that would create a *new* track first run the same match tiers against the removed pool (`removedAt != null`). On match: clear `removedAt`, update path/file fields/hash, apply the replacement re-analysis rule if the hash changed. A file that comes back — at its old path or anywhere else — picks up its full history. This also upgrades move detection from same-scan-only to **cross-scan**: a reorg done in several sittings, a temporarily unmounted disk, or a restore from backup all re-bind instead of duplicating.

Same-path collision: if a *different* file appears at a removed row's path, rule 1 applies to that row (path wins — the row revives as a replacement). The unique constraint on `filePath` therefore never conflicts: removed rows keep their last-known path, and a new arrival at that path revives rather than colliding.

**Exclusion audit (the real cost).** Every read surface must treat `removedAt != null` as nonexistent: browse routes (`routes/library/*`), search (`services/search.ts` raw FTS SQL), mixes/radio/shuffle (`random` sampling), vibe/similarity (ANN queries in `utils/annQuery.ts`, `services/hybridSimilarity.ts` — join back to active tracks), Subsonic (`routes/subsonic.ts`), denormalized counts (`artistCountsService.ts`), homepage/recently-added, and stream resolution (a removed track is unplayable). Playlists deliberately *show* removed items greyed/unplayable (existing `UnplayableBadge`/`isPlayable` pattern) rather than hiding them — the user can see what a restore would bring back. Album/artist rows with zero active tracks disappear from browse via the count filters. This audit is the bulk of the implementation and test effort; a shared Prisma `where` fragment / SQL predicate keeps it greppable and consistent.

**Retention.** Removed rows don't live forever: a scheduled purge worker (existing cron/worker pattern) hard-deletes rows where `removedAt` is older than a configurable retention window (`TRACK_REMOVAL_RETENTION_DAYS`, default 90; `0` = purge immediately, restoring today's semantics for users who want it). Purge is the single place the old cascade still fires, now deliberate instead of accidental. An admin Library Health surface lists removed-pending-purge tracks (count + restore-by-rescan hint), reusing `LibraryHealthRecord`'s existing `MISSING_FROM_DISK` reporting.

The existing "empty directory" guard stays: when a scan finds zero audio files (unmounted volume), tracks are health-flagged but not even soft-removed.

### Phasing

| Phase | Scope |
| --- | --- |
| **1. Identity columns** | Schema migration; scanner reads `recordingMbid`/`isrc` from tags in the existing metadata pass; audio-hash computation for new/changed files; backfill worker populates audio hashes and tag identity keys for the existing library |
| **2. Soft delete + revival** | `removedAt` migration; scanner marks instead of deletes; revival tiers on scan; exclusion audit across read surfaces; purge worker + retention config; Library Health surface |
| **3. Move detection & replacement semantics** | Same-scan and cross-scan tier matching; replacement detection (same path, hash delta) with analysis/embedding/transcode re-queue |
| **4 (deferred). Fingerprinting** | Opt-in AcoustID/Chromaprint (`fpcalc`) as a tier above tags for untagged libraries, via the analyzer-queue pattern — only if 1–3 prove insufficient |

Phases 2 and 3 both depend on 1 but not on each other; 2 ships the "nothing is ever lost" guarantee, 3 ships the "identity follows the file" guarantee.

### Downstream consumers (why this is worth it beyond the bug fix)

- `TrackMapping` arbitration (`services/trackMappingService.ts`) gains exact `recordingMbid`/local-`isrc` tiers above the current `isrc`(Tidal-side) > `import-match` > `gap-fill` hierarchy.
- Federation (#451) consumes `audioHash`/`recordingMbid`/`isrc` in its catalog envelope as top dedup tiers; soft delete maps directly onto its tombstone/delta feed (a "removed" event instead of a hard tombstone, revival instead of re-add); host-side reorgs stop churning the feed entirely.
- Playlist import (`routes/playlistImport.ts`) can match by ISRC when the source provides one.
- Duplicate-file detection (same `audioHash`, two active paths) becomes a free Library Health report.

## Testing

Behavioral tests against real PostgreSQL, per repo contract (no source-text assertions):

- Scan → move file → rescan: `Track.id` unchanged; `PlaylistItem`, `LikedTrack`, `TrackEmbedding` survive; `filePath` updated; analysis NOT re-queued (hash unchanged).
- **Same-path quality replacement** (new bytes, same path): id unchanged; hash updated; analysis/embedding re-queued; transcode cache invalidated.
- **Retag in place**: hash unchanged; metadata refreshed; no re-analysis.
- **Extension upgrade** (`.mp3` → `.flac`, same basename): tag/position tier matches; id preserved; re-analysis queued.
- **Whole-album re-rip** (new folder contents, new filenames, same rgMbid): every track re-binds; playlists intact.
- **Soft delete**: file removed → row marked, relations intact, excluded from browse/search/shuffle/Subsonic/counts, playlist row shows unplayable.
- **Revival, same path** and **revival, new path after N scans** (hash match from removed pool): `removedAt` cleared, history intact.
- **Purge**: rows past retention hard-deleted; younger rows kept; `TRACK_REMOVAL_RETENTION_DAYS=0` purges on next cycle.
- Ambiguous candidates (two identical files moved): tier abstains; rows soft-removed — never mis-bound.
- Hash backfill job: resumable, bounded batches, skips already-hashed rows; steady-state scan hashes zero unchanged files.
- Regression: empty-directory guard still skips removal entirely.

## Effort

Medium-large. Phase 1 ≈ 1 week equivalent (migration, tag reads, hash plumbing, backfill worker). Phase 2 ≈ 2–3 weeks (the exclusion audit across browse/search/mixes/vibe/Subsonic is the long tail). Phase 3 ≈ 1–2 weeks. No new dependencies, no new services, two migrations.

## Sequencing

Ship before federation (#451). Federation's track-level dedup, delta-feed stability, and tombstone semantics all assume these columns and removal semantics exist; building it first also delivers immediate value to every existing single-instance deployment.
