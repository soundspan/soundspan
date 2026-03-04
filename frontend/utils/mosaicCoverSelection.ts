/**
 * Shared selection logic for mosaic cover art (2x2 / 3x2 grids).
 *
 * Multi-phase algorithm maximises visual diversity:
 * 1. Unique artist + unique album + unique cover (strongest diversity)
 * 2. Unique cover only (visual variety)
 * 3. Any remaining candidate
 * 4. Recycle selected covers to fill remaining slots (opt-in)
 */

/** A candidate for mosaic tile selection. */
export interface MosaicCoverCandidate {
    /** Stable identifier for the source item. */
    id: string;
    /** Already-resolved cover image URL. */
    coverUrl: string;
    /** Optional key for artist-level dedup (e.g. lowercase name or id). */
    artistKey?: string;
    /** Optional key for album-level dedup (e.g. lowercase title or id). */
    albumKey?: string;
}

/** A selected mosaic tile. */
export interface MosaicCoverResult {
    candidateId: string;
    coverUrl: string;
}

export interface SelectMosaicCoversOptions {
    /** Number of tiles to fill.  @default 4 */
    count?: number;
    /**
     * When true and fewer candidates than `count` exist, cycle through
     * selected tiles to fill remaining slots.  @default false
     */
    recycleFallback?: boolean;
}

/**
 * Selects covers for a mosaic grid, maximising artist/album/cover diversity.
 *
 * When `artistKey` or `albumKey` is absent on a candidate that dimension
 * is treated as always-unique (never blocks selection).
 */
export function selectMosaicCovers(
    candidates: readonly MosaicCoverCandidate[],
    options: SelectMosaicCoversOptions = {},
): MosaicCoverResult[] {
    const { count = 4, recycleFallback = false } = options;
    if (count <= 0 || candidates.length === 0) return [];

    const selected: MosaicCoverResult[] = [];
    const selectedIds = new Set<string>();
    const usedArtists = new Set<string>();
    const usedAlbums = new Set<string>();
    const usedCovers = new Set<string>();

    const push = (c: MosaicCoverCandidate): boolean => {
        if (selectedIds.has(c.id)) return false;
        selected.push({ candidateId: c.id, coverUrl: c.coverUrl });
        selectedIds.add(c.id);
        if (c.artistKey) usedArtists.add(c.artistKey);
        if (c.albumKey) usedAlbums.add(c.albumKey);
        usedCovers.add(c.coverUrl);
        return true;
    };

    // Phase 1: unique artist + unique album + unique cover
    for (const c of candidates) {
        if (selected.length >= count) break;
        const artistOk = !c.artistKey || !usedArtists.has(c.artistKey);
        const albumOk = !c.albumKey || !usedAlbums.has(c.albumKey);
        const coverOk = !usedCovers.has(c.coverUrl);
        if (artistOk && albumOk && coverOk) push(c);
    }

    // Phase 2: unique cover only
    for (const c of candidates) {
        if (selected.length >= count) break;
        if (!usedCovers.has(c.coverUrl)) push(c);
    }

    // Phase 3: any remaining candidate
    for (const c of candidates) {
        if (selected.length >= count) break;
        push(c);
    }

    // Phase 4: recycle (opt-in)
    if (recycleFallback && selected.length > 0) {
        let recycleIdx = 0;
        while (selected.length < count) {
            const src = selected[recycleIdx % selected.length];
            selected.push({
                candidateId: `${src.candidateId}::recycle-${recycleIdx}`,
                coverUrl: src.coverUrl,
            });
            recycleIdx++;
        }
    }

    return selected.slice(0, count);
}

/** Accessor functions for converting domain objects to MosaicCoverCandidate. */
export interface MosaicCandidateAccessors<T> {
    getId: (item: T) => string;
    getCoverUrl: (item: T) => string | null | undefined;
    getArtistKey?: (item: T) => string | null | undefined;
    getAlbumKey?: (item: T) => string | null | undefined;
}

/**
 * Generic adapter that maps an array of domain objects into
 * MosaicCoverCandidate[], skipping items without a cover URL.
 */
export function createMosaicCandidates<T>(
    items: readonly T[],
    accessors: MosaicCandidateAccessors<T>,
): MosaicCoverCandidate[] {
    const result: MosaicCoverCandidate[] = [];
    for (const item of items) {
        const coverUrl = accessors.getCoverUrl(item);
        if (!coverUrl) continue;
        const candidate: MosaicCoverCandidate = {
            id: accessors.getId(item),
            coverUrl,
        };
        const artistKey = accessors.getArtistKey?.(item);
        if (artistKey) candidate.artistKey = artistKey;
        const albumKey = accessors.getAlbumKey?.(item);
        if (albumKey) candidate.albumKey = albumKey;
        result.push(candidate);
    }
    return result;
}
