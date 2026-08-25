import { normalizeForExactKey } from "../utils/artistNormalization";

/** Identity fields used to match a disappeared track to a newly scanned row. */
export interface TrackIdentity {
    id: string;
    filePath: string;
    fileSize: number;
    duration: number;
    title: string;
    discNo: number;
    trackNo: number;
    audioHash: string | null;
    recordingMbid: string | null;
    isrc: string | null;
    album: { rgMbid: string | null };
}

/** Ordered identity tier that established a move match. */
export type TrackIdentityTier =
    | "audioHash"
    | "recordingMbid"
    | "isrc"
    | "albumPositionTitleDuration"
    | "fileSizeTitleDuration";

/** One unambiguous old-row to new-row identity match. */
export interface TrackIdentityMatch<
    Missing extends TrackIdentity = TrackIdentity,
    Candidate extends TrackIdentity = TrackIdentity,
> {
    missing: Missing;
    candidate: Candidate;
    tier: TrackIdentityTier;
}

type IdentityPair<
    Missing extends TrackIdentity,
    Candidate extends TrackIdentity,
> = Pick<TrackIdentityMatch<Missing, Candidate>, "missing" | "candidate">;

type TierMatcher = <
    Missing extends TrackIdentity,
    Candidate extends TrackIdentity,
>(
    missing: readonly Missing[],
    candidates: readonly Candidate[],
) => Array<IdentityPair<Missing, Candidate>>;

interface TierDefinition {
    tier: TrackIdentityTier;
    match: TierMatcher;
}

const ALBUM_DURATION_TOLERANCE_SECONDS = 10;
const FILE_DURATION_TOLERANCE_SECONDS = 2;

function nonEmptyKey(value: string | null): string | null {
    return value !== null && value.length > 0 ? value : null;
}

function buildGroups<Row>(
    rows: readonly Row[],
    keyFor: (row: Row) => string | null,
): Map<string, Row[]> {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
        const key = keyFor(row);
        if (key === null) continue;
        const group = groups.get(key);
        if (group) group.push(row);
        else groups.set(key, [row]);
    }
    return groups;
}

function findExactMatches<
    Missing extends TrackIdentity,
    Candidate extends TrackIdentity,
>(
    missing: readonly Missing[],
    candidates: readonly Candidate[],
    keyFor: (track: TrackIdentity) => string | null,
): Array<IdentityPair<Missing, Candidate>> {
    const missingGroups = buildGroups(missing, keyFor);
    const candidateGroups = buildGroups(candidates, keyFor);
    const matches: Array<IdentityPair<Missing, Candidate>> = [];
    for (const [key, missingGroup] of missingGroups) {
        const candidateGroup = candidateGroups.get(key);
        if (missingGroup.length !== 1 || candidateGroup?.length !== 1) {
            continue;
        }
        matches.push({
            missing: missingGroup[0],
            candidate: candidateGroup[0],
        });
    }
    return matches;
}

function validInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

/** Rows can surface null/empty titles at runtime; those never form a key. */
function normalizedTitleKey(title: string | null | undefined): string | null {
    if (typeof title !== "string" || title.length === 0) return null;
    const normalized = normalizeForExactKey(title);
    return normalized.length > 0 ? normalized : null;
}

function albumPositionTitleKey(track: TrackIdentity): string | null {
    const rgMbid = nonEmptyKey(track.album.rgMbid);
    const title = normalizedTitleKey(track.title);
    if (!rgMbid || !title || !validInteger(track.discNo)) return null;
    if (!validInteger(track.trackNo)) return null;
    return JSON.stringify([rgMbid, track.discNo, track.trackNo, title]);
}

function fileSizeTitleKey(track: TrackIdentity): string | null {
    const title = normalizedTitleKey(track.title);
    if (!title || !validInteger(track.fileSize)) return null;
    return JSON.stringify([track.fileSize, title]);
}

type DurationIndex<Row> = Map<string, Map<number, Row[]>>;

function buildDurationIndex<Row extends TrackIdentity>(
    rows: readonly Row[],
    baseKeyFor: (track: TrackIdentity) => string | null,
): DurationIndex<Row> {
    const index: DurationIndex<Row> = new Map();
    for (const row of rows) {
        const baseKey = baseKeyFor(row);
        if (baseKey === null || !validInteger(row.duration)) continue;
        const durations = index.get(baseKey) ?? new Map<number, Row[]>();
        const group = durations.get(row.duration);
        if (group) group.push(row);
        else durations.set(row.duration, [row]);
        index.set(baseKey, durations);
    }
    return index;
}

function findSingleWithin<Row>(
    index: DurationIndex<Row>,
    baseKey: string,
    duration: number,
    tolerance: number,
): Row | null {
    const durations = index.get(baseKey);
    if (!durations) return null;
    let match: Row | null = null;
    let count = 0;
    for (let offset = -tolerance; offset <= tolerance; offset += 1) {
        const group = durations.get(duration + offset);
        if (!group) continue;
        count += group.length;
        if (count > 1) return null;
        match = group[0] ?? null;
    }
    return count === 1 ? match : null;
}

function findDurationMatches<
    Missing extends TrackIdentity,
    Candidate extends TrackIdentity,
>(
    missing: readonly Missing[],
    candidates: readonly Candidate[],
    baseKeyFor: (track: TrackIdentity) => string | null,
    tolerance: number,
): Array<IdentityPair<Missing, Candidate>> {
    const missingIndex = buildDurationIndex(missing, baseKeyFor);
    const candidateIndex = buildDurationIndex(candidates, baseKeyFor);
    const matches: Array<IdentityPair<Missing, Candidate>> = [];
    for (const missingTrack of missing) {
        const baseKey = baseKeyFor(missingTrack);
        if (baseKey === null || !validInteger(missingTrack.duration)) continue;
        const candidate = findSingleWithin(
            candidateIndex,
            baseKey,
            missingTrack.duration,
            tolerance,
        );
        if (!candidate) continue;
        const claimant = findSingleWithin(
            missingIndex,
            baseKey,
            candidate.duration,
            tolerance,
        );
        if (claimant?.id === missingTrack.id) {
            matches.push({ missing: missingTrack, candidate });
        }
    }
    return matches;
}

const TIERS: readonly TierDefinition[] = [
    {
        tier: "audioHash",
        match: (missing, candidates) =>
            findExactMatches(missing, candidates, (track) =>
                nonEmptyKey(track.audioHash),
            ),
    },
    {
        tier: "recordingMbid",
        match: (missing, candidates) =>
            findExactMatches(missing, candidates, (track) =>
                nonEmptyKey(track.recordingMbid),
            ),
    },
    {
        tier: "isrc",
        match: (missing, candidates) =>
            findExactMatches(missing, candidates, (track) =>
                nonEmptyKey(track.isrc),
            ),
    },
    {
        tier: "albumPositionTitleDuration",
        match: (missing, candidates) =>
            findDurationMatches(
                missing,
                candidates,
                albumPositionTitleKey,
                ALBUM_DURATION_TOLERANCE_SECONDS,
            ),
    },
    {
        tier: "fileSizeTitleDuration",
        match: (missing, candidates) =>
            findDurationMatches(
                missing,
                candidates,
                fileSizeTitleKey,
                FILE_DURATION_TOLERANCE_SECONDS,
            ),
    },
];

/**
 * Matches disappeared rows to newly created rows by strict identity tiers.
 * A tier accepts only one-to-one relationships; ambiguous rows continue to
 * lower tiers, and every accepted candidate is consumed exactly once.
 */
export function matchTrackIdentities<
    Missing extends TrackIdentity,
    Candidate extends TrackIdentity,
>(
    missing: readonly Missing[],
    candidates: readonly Candidate[],
): Array<TrackIdentityMatch<Missing, Candidate>> {
    let remainingMissing = [...missing];
    let remainingCandidates = [...candidates];
    const matches: Array<TrackIdentityMatch<Missing, Candidate>> = [];
    for (const definition of TIERS) {
        const tierMatches = definition.match(
            remainingMissing,
            remainingCandidates,
        );
        if (tierMatches.length === 0) continue;
        const missingIds = new Set(tierMatches.map((pair) => pair.missing.id));
        const candidateIds = new Set(
            tierMatches.map((pair) => pair.candidate.id),
        );
        for (const pair of tierMatches) {
            matches.push({ ...pair, tier: definition.tier });
        }
        remainingMissing = remainingMissing.filter(
            (track) => !missingIds.has(track.id),
        );
        remainingCandidates = remainingCandidates.filter(
            (track) => !candidateIds.has(track.id),
        );
    }
    return matches;
}
