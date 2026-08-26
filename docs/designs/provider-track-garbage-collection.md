# Provider track garbage collection

Status: shipped.

`TrackTidal` and `TrackYtMusic` rows use one retention policy for garbage
collection and parent-catalog liveness.

A provider row is retained when it has an active `TrackMapping`, a mapping
whose stale timestamp is within the retention window, a `LikedRemoteTrack`, a
`PlaylistItem`, a `Play` within the retention window, or a creation timestamp
within the window. A stale mapping without `staleAt` is retained fail-safe.
Old unmapped rows are collectable after the same window.

`PROVIDER_TRACK_RETENTION_DAYS` controls the window. The default is 30 days.
This covers transient provider outages and recent listening while bounding
metadata that can otherwise pin empty albums and artists indefinitely. The
value is read at process startup and must be from 1 through 3650 days.

The existing `track-removal-purge` startup and daily scheduler invokes provider
GC. Each transaction selects at most 100 TIDAL and 100 YouTube Music rows. One
invocation continues for at most 50 transactions, so it can delete up to 5,000
rows per provider without allowing an unbounded sweep. Each delete repeats the
full liveness predicate. Prometheus exposes deleted-row counters, capped
remaining-backlog and oldest-collectable-age gauges by provider, and
pass-duration histograms by outcome.

`TrackMapping.staleAt` supplies the stale clock. The migration timestamps all
existing stale mappings at migration time, so deployment does not immediately
collect them. A database trigger maintains the timestamp for mixed-version and
future writers.

After each pass, the existing orphan cleanup applies the same policy to albums
and artists. An `OwnedAlbum` reference or manual `hasUserOverrides` flag keeps
the applicable album or artist. With federation enabled, cleanup writes album
and artist tombstones in its deletion transaction. Federation delta export
already includes those tombstone types, so peers remove parents that become
empty. When federation is disabled, parent cleanup mirrors track purge and does
not write tombstones.

Direct foreign-key references are `TrackMapping`, `LikedRemoteTrack`,
`PlaylistItem`, and `Play`. Offline cache rows reference local `Track` rows.
Playback, Listen Together, and sync queues store JSON or generic identifiers;
they do not hold provider-row foreign keys and are not durable retention edges.
