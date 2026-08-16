# Blends and Federated Discovery

Spec drafted 2026-08-16 for [issue #529](https://github.com/soundspan/soundspan/issues/529) (Blends) and [issue #530](https://github.com/soundspan/soundspan/issues/530) (federated discovery). Status: design phase. Shared foundation: per-user **taste vectors** and the embedding-space identity contract from `vibe-embedding-provider.md`. Peer observability ([issue #531](https://github.com/soundspan/soundspan/issues/531)) instruments everything here.

## Taste vectors (shared primitive)

A user's taste is represented as **k weighted centroids** (k≤5) over their track embeddings, not one mean — eclectic taste survives clustering, collapses under averaging.

- Inputs: play history (recency-decayed half-life ~90 days), thumbs (up boosts, down excludes the neighborhood), likes; skips damp. All signals already exist.
- Computed per user on a weekly worker + on-demand invalidation after heavy listening days (threshold on new-play count).
- Stored with `spaceId`; recomputed automatically on embedding-space cutover (registry migration hooks).
- Cold start (< N plays): fall back to library-composition centroids (what they *have*), flagged `lowConfidence` so consumers can weight accordingly.

## Blends

### Generation

- Members: 2..M users, local or cross-peer. Candidate pool: union of members' accessible catalogs (local library; peer catalogs only where that peer's sharing already permits the member).
- Scoring: **max–min fairness** — a candidate's score is the *minimum* over members of its best affinity to that member's centroids. Averages find the bland intersection; max–min finds tracks each member genuinely rates. Tie-shaping: prefer tracks strong for members whose representation in the running playlist is lowest (running fairness balance).
- Constraints reuse the programmatic-playlist toolkit: artist caps, recent-play exclusion per member, target length, optional energy curve.
- **Attribution**: each pick stores the member whose affinity carried it (argmax contributor) → "here because of Sam" badges. Refresh weekly via the existing scheduler; members can pin tracks (pinned survive refresh).

### Cross-peer membership

- A remote member's home peer computes their taste vectors locally and shares `{spaceId identity tuple, centroids, weights, lowConfidence}` through a new authenticated federation endpoint — **history never crosses the wire, only derived vectors**.
- Space mismatch (peers on different embedding spaces) ⇒ that member participates via metadata-only affinity (genre/artist overlap), badged as approximate; never silently degraded.
- Privacy contract (documented in the federation docs): centroids reveal taste direction, not listening events; sharing is opt-in **per blend membership**, revocable (revocation deletes the vectors on the consuming peer — deletion API + test); vectors carry no track references.

### Playback

Blend tracks resolve per listener: local copy if the listener's library (or dedup identity) has it, else peer stream via the existing federation proxy, else greyed with the acquisition affordance (below).

## Federated discovery

### Phase 0 — federated public playlists and presence (maintainer-directed first increment)

Ships before any taste-vector work; requires none of the embedding-space machinery — only surfaces that already exist (catalog sync, federation auth, the stream proxy, the social/activity feed).

- **Public playlists across peers**: playlists a user marks public become visible to trusted peers with discovery opt-in — browsable in a "From PeerName" shelf, loadable, and playable. Playlist metadata (name, owner display name, track references, cover) exchanges over a new authenticated federation endpoint; track rows resolve per listener local-first via durable identity/dedup, then peer stream proxy, with the standard offline row states. A peer playlist can be followed (live reference, updates with the source) or copied (snapshot into the local library); acquisition affordances apply to peer-only tracks.
- **User status across peers**: presence (online/listening state) and now-playing/recently-played activity from federated friends appear in the existing social/activity surface, badged with their home peer. Exchange is lightweight polling or piggybacked on existing peer sync heartbeats — no new realtime channel in phase 0; freshness is minutes, not seconds, and the UI says so.
- **Privacy model**: two gates compose — the operator-level federation discovery opt-in (per peer, both directions), and a **per-user visibility setting** controlling whether that user's public playlists and presence federate at all (playlist publicness alone does not imply federation). Presence sharing is per-user opt-out within an enabled peering, playlist federation per-user opt-in-by-public-flag; both documented in the federation privacy contract alongside the taste-vector rules.
- **Telemetry**: peer playlist follows/copies/plays and presence-fetch health join the per-peer counters (issue #531).

### Candidate sourcing

- Peer catalogs (already synced) join the Discover Weekly/radio candidate pool when the peer relationship has **discovery opt-in** (new flag, both directions, default off).
- Affinity scoring needs embeddings for peer tracks: preferred — peers share per-track embedding vectors during catalog sync when spaces match (bulk, batched, sync-time not query-time); fallback — metadata-level scoring, badged approximate. Space rules identical to blends.
- **Ratio cap**: peer-sourced picks ≤ configurable share of any generated list (default 20%), and never displace a strictly-better local pick (peer candidates compete only for their capped slots).

### Identity and dedup

Durable track identity + dedup arbitration guarantee a peer track that matches a local one is treated as the local track (no "new to you" lies, no duplicate rows). Recommendation surfaces show provenance only when the track is genuinely peer-only.

### Degradation and acquisition

- Peer offline at play time: skip forward with a subtle "unavailable — PeerName offline" row state; weekly playlists never contain dead rows silently (the row renders with state).
- **"Get it locally"**: any peer-only pick offers one-tap add to the acquisition want-list (existing Lidarr/Soulseek pipeline) — discovery converts into library growth. Metrics count conversions.

### Telemetry

Per-peer counters (bounded labels, extending #531): candidates offered/accepted into lists, plays of peer-sourced picks, availability failures, acquisition conversions. These tune the ratio cap from data.

## Rollout and testing

0. **Federated public playlists + presence** (no vector dependency; first social increment) →
1. Taste vectors + local 2-user Blend (fairness + attribution + refresh) →
2. Cross-peer blend membership (vector sharing contract + revocation) →
3. Federated discovery candidates behind opt-in + ratio cap →
4. Acquisition hook + telemetry-driven tuning.
- Tests: fairness scoring fixtures (constructed member clusters with known correct picks, incl. the average-vs-max–min discriminating case); cold-start; attribution correctness; vector-sharing auth/revocation (federation runtime suites); space-mismatch degradation; ratio-cap enforcement; offline-row states (component harness).

## Non-goals

- Global/public peer discovery directories (trust stays operator-configured).
- Sharing raw play history or per-track user signals across peers, ever.
- Real-time collaborative queues (Listen Together exists; blends are asynchronous artifacts).

## Open questions

- Blend size ceiling M (proposal: 8) and whether >2-member blends need per-member weight sliders.
- Whether taste centroids should also power a local "taste match %" between users on the same instance (cheap, fun, zero privacy cost locally — likely yes, small follow-up).
