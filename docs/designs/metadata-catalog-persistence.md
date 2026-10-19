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

A fresh artist discography lists only that artist's own `CATALOG` albums. A
release group that already has an album row, in any location and for any
artist, is not persisted again. The library artist page shows such a release
group only when that album is one of the artist's visible albums. When the
library artist page cannot read the catalog, it asks MusicBrainz.

An hourly worker removes at most 50 oldest catalog albums per run after 180
untouched days. `CATALOG_RETENTION_DAYS` changes the retention window. Download
jobs, music requests, track preferences, ratings, and playlist items retain
referenced albums. Deleting an album cascades to its skeleton tracks.

The feature defaults on. `CATALOG_PERSISTENCE=off` disables catalog reads,
writes, and retention. Catalog skeletons are local cache state and are never
included in federation exports.
