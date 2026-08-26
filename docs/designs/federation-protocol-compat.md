# Federation Protocol Compatibility for Additive Fields

Drafted 2026-08-18. Status: shipped (receiver + sender).

## Problem

The peer track-envelope schema (`trackAttributesSchema` in `backend/src/services/federationClient.ts`) is a `z.strictObject`: any key the receiver does not know invalidates the envelope, and the page parser then skips that track (counted in `skippedInvalid`). Every additive field therefore breaks new-sender → old-receiver sync for exactly the rows that carry the new data. The loudness rollout (#591) mitigated this by omitting the new keys when null, but that only protects unmeasured rows; measured tracks still vanish from old peers, and every future field re-fights the same battle. There is no protocol version or general capability signal — only the single-purpose embedding space-capability gate from #564.

## Decision

Two complementary changes, shippable independently, receiver-side first:

### 1. Tolerant envelope parsing (receiver)

Replace the strict envelope with **validate-known, strip-unknown, count-unknown**:

- Known fields keep their exact current validation (types, finiteness, bounds).
- Unknown keys are stripped before ingest and counted in a new metric label (`soundspan_federation_sync_skips{reason="unknown_key_stripped"}` or the existing counter family's convention) plus a throttled log naming the keys, so drift is visible instead of silent.
- This is safe because ingest is already a whitelist: `federationSyncPage` maps only known fields into the database, so an unknown key never had a write path. Envelope-level strictness was rejecting valid data over version skew — an availability defect wearing a security costume. Security posture is unchanged: known-field validation, peer authentication, and the space-identity guard all remain strict.

### 2. Capability advertisement (sender gating)

Extend the peer handshake/status exchange with a `capabilities: string[]` block (pattern: the embedding space-capability probe from #564, generalized). Senders gate emission of post-v1 field groups on the receiver's advertised capability (first entry: `track-attrs-loudness` covering `loudnessLufs`/`truePeakDb`). Unknown capabilities are ignored. This keeps cross-version payloads minimal and makes "what does my peer understand" observable, but tolerance (change 1) remains the actual safety net when capability data is stale or absent.

## Non-goals

- Renaming or retyping existing fields (still a breaking change requiring coordinated upgrade).
- Versioning the transport or endpoints; the REST surface is unchanged.
- Retroactive re-sync of envelopes old peers skipped before this ships (they repair on their next full sync after upgrading).

## Rollout

1. Ship tolerant parsing + metric (receiver). Peers benefit as they upgrade.
2. Ship capability advertisement + loudness gating (sender) in the same or next release.
3. Future additive fields: add to the schema as optional, assign a capability, done — no skew hazard.
