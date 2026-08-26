# Metadata catalog persistence

Status: shipped.

MusicBrainz release groups and tracklists already fetched for artist and album
views are retained as hidden local skeletons. Persisted albums use the
`CATALOG` `AlbumLocation`; their tracks have no playable file path and remain
excluded from library, search, enrichment, and federation surfaces.

Persistence is write-through only. Provider responses remain authoritative,
Redis stays the hot cache, and fresh catalog rows are read only after a Redis
miss. Artist discographies and album tracklists are fresh for seven days.
Reads refresh `catalogTouchedAt` without delaying the response.

An hourly worker removes at most 50 oldest catalog albums per run after 180
untouched days. `CATALOG_RETENTION_DAYS` changes the retention window. Download
jobs, music requests, track preferences, ratings, and playlist items retain
referenced albums. Deleting an album cascades to its skeleton tracks.

The feature defaults on. `CATALOG_PERSISTENCE=off` disables catalog reads,
writes, and retention. Catalog skeletons are local cache state and are never
included in federation exports.
