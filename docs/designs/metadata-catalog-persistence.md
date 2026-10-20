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

An artist discography sync stores the artist's MusicBrainz release groups as
`ArtistCatalogReleaseGroup` rows, at most 100 per artist. Each row keeps the
release group's position, title, first-release date, primary type, and
secondary types. A sync replaces the artist's whole list and then sets
`Artist.catalogSyncedAt`. Routes store the list before they filter it and apply
their own release-type filters when they read it, so a fresh catalog returns
the same discography as MusicBrainz. The list does not depend on album rows: a
release group held by another artist's album, or by an album in another
location, stays in the list.

A sync also creates a `CATALOG` album skeleton for each listed release group
that has no album row yet. Album tracklists persist beneath these skeletons. A
release group that already has an album row, in any location and for any
artist, gets no skeleton.

The MusicBrainz client answers a failed release-group lookup with an empty
list. A sync with no release groups therefore writes nothing and leaves
`catalogSyncedAt` unchanged. A catalog with no release-group rows reads as a
miss. When a route cannot read the catalog, it asks MusicBrainz. The library
artist page caches an empty discography for two minutes instead of a day.

An hourly worker removes at most 50 oldest catalog albums per run after 180
untouched days. `CATALOG_RETENTION_DAYS` changes the retention window. Download
jobs, music requests, track preferences, ratings, and playlist items retain
referenced albums. Deleting an album cascades to its skeleton tracks. Deleting
an artist cascades to its release-group rows.

The feature defaults on. `CATALOG_PERSISTENCE=off` disables catalog reads,
writes, and retention. Catalog skeletons are local cache state and are never
included in federation exports.
