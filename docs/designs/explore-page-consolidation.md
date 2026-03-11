# Explore Page Consolidation

Brainstormed 2026-03-02. Status: design phase, no implementation yet.

## Core Concept

Consolidate Home, Browse, Radio, and Discovery pages into a single "Explore" page that becomes the default landing experience. The thesis: all of these answer "what should I listen to next?" but currently fragment that across 4+ surfaces.

## What Gets Absorbed

| Current Surface | Where It Lives Today | Destination in Explore |
|---|---|---|
| Made For You mixes | Home (row) | For You tab (playlist cards) |
| Radio stations (quick-start, genre, decade) | Home (carousel) + `/radio` (full page) | For You tab (personal stations) + Moods & Genres tab (genre/decade) |
| Browse (YT Music shelves/charts/moods/genres, TIDAL spotlight) | `/browse/playlists` | Trending tab + Moods & Genres tab |
| Featured Playlists (YT Music charts) | Home (row) | Trending tab |
| Discover Weekly | `/discover` (full page) | For You tab (playlist card) |
| My Liked | Sidebar nav -> `/playlist/my-liked` | For You tab (playlist card) |
| Recommended artists (Last.fm) | Home (row) | For You tab |
| Popular artists (Last.fm) | Home (row) | Trending tab |
| Continue Listening | Home (row) | Above tabs (always visible) |
| Recently Added | Home (row) | Above tabs (always visible) |

## Page Layout (Agreed)

```
/explore (default landing, replaces /)

[Continue Listening — above tabs, always visible]
[Recently Added — above tabs, always visible]

[Tabs: For You | Trending | Moods & Genres]

For You:
  - My Liked (playlist card)
  - Discover Weekly (playlist card, generates on first view if absent)
  - Made For You mixes (playlist cards)
  - Personal radio stations (genre/decade)
  - Recommended artists (Last.fm)

Trending:
  - YT Music featured shelves
  - YT Music charts
  - TIDAL spotlight (when connected)
  - Popular artists (Last.fm)

Moods & Genres:
  - YT Music mood categories
  - YT Music genre categories
  - Local genre radio stations (merged contextually)
  - Local decade radio stations
```

## Sidebar After Consolidation

```
Explore        (new, default landing)
Library
Listen Together
Audiobooks
Podcasts
```

Down from 8 items (Library, My Liked, Radio, Discovery, Listen Together, Audiobooks, Podcasts, Browse) to 5.

## Key Design Decisions

1. **Scroll + tabs hybrid:** Tabs for top-level mode (For You / Trending / Moods & Genres), scrollable sections within each tab.
2. **My Liked as a playlist card:** Not a nav destination. Shows alongside Discover Weekly and Made For You mixes in For You tab. YouTube Music pattern.
3. **Discover Weekly in Explore:** Shows as a playlist card. If it doesn't exist yet, generate it on first view. Dedicated `/discover` page stays alive but hidden from nav.
4. **Continue Listening / Recently Added above tabs:** Always visible regardless of active tab. Acknowledged as needing enrichment in v2 (e.g., "album you were halfway through" instead of just "recent artists").
5. **Playlist import moves to playlist management page:** No longer in Browse.
6. **Podcasts and Audiobooks stay separate:** Not music discovery, keep their own pages/nav items.
7. **Old routes stay alive:** `/radio`, `/discover`, `/browse/playlists`, `/playlist/my-liked` remain accessible via direct URL for backwards compat. Just hidden from nav.

## Open Items for Later

- **Continue Listening enrichment:** Currently just recent artists. Could become "pick up where you left off" (album progress, playlist position, podcast pause point). Needs session/progress data model.
- **Recently Added enrichment:** Could become "what changed in your world" — new albums from followed artists, library scan results, etc.
- **Discover Weekly extension:** Could generate multiple playlist types (mood-based discovery, genre exploration, etc.) beyond the single weekly. Parked for now since Made For You mixes already provide variety.

## Implementation Notes

- Browse page has already migrated to YT Music (not Deezer). The code fetches from `/browse/ytmusic/*` endpoints. DeezerIcon only remains for the URL import modal.
- Browse page does NOT use React Query (all manual useState/useCallback/useEffect). Consistency gap to fix during refactor.
- Radio logic is heavily duplicated between `LibraryRadioStations` (Home component) and `/radio/page.tsx` — same static stations, color maps, startRadio function. Must unify.
- Home page's "Featured Playlists" row already hits the same YT Music charts endpoint as Browse.

## Phased Approach (Suggested)

1. **Phase 1:** Build Explore page shell, compose from existing components, update nav
2. **Phase 2:** Refactor duplicated Radio logic, migrate Browse to React Query, extract Discover into reusable component
3. **Phase 3:** Make `/` redirect to `/explore`, deprecate old routes from nav
