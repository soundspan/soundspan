import { normalizeForExactKey } from "../utils/artistNormalization";
import { isValidMbid } from "../utils/musicIds";

type MatchTier = "exact" | "edition";
type SupportedPrimaryType = "Album" | "EP" | "Single";

/** MusicBrainz release-group fields already checked for artist eligibility. */
export interface RemoteAlbumMbidCandidate {
    rgMbid: string;
    title: string;
    primaryType: string;
    artistMatches: boolean;
    score?: number;
}

/** Confident release-group identity selected for one remote album. */
export interface RemoteAlbumMbidMatch {
    rgMbid: string;
    tier: MatchTier;
    primaryType: SupportedPrimaryType;
}

type TieredCandidate = RemoteAlbumMbidCandidate & { tier: MatchTier };
type RankedCandidate = RemoteAlbumMbidMatch;

interface RemoteAlbumMbidMatchOptions {
    allowSingle: boolean;
}

const PRIMARY_TYPES = ["Album", "EP", "Single"] as const;
const MAX_EDITION_GROUPS = 3;
const MAX_EDITION_TITLE_LENGTH = 500;
const EDITION_WORD =
    /^(?:deluxe|super|expanded|remaster|remastered|anniversary|bonus|tracks?|explicit|clean|mono|stereo|edition|version|special|collector(?:['’]?s)?|limited|digital|standard|\d{4}|\d+(?:st|nd|rd|th))$/i;
const NUMERIC_EDITION_WORD = /^(?:\d{4}|\d+(?:st|nd|rd|th))$/i;

function trailingEditionGroup(title: string): RegExpMatchArray | null {
    return title.match(
        /\s*(?:\(([^()]*)\)|\[([^\[\]]*)\]|\s-\s((?:(?!\s-\s).)+))\s*$/,
    );
}

function isEditionGroup(value: string): boolean {
    const words = value.trim().split(/\s+/);
    return (
        words.length > 0 &&
        words.every((word) => EDITION_WORD.test(word)) &&
        words.some((word) => !NUMERIC_EDITION_WORD.test(word))
    );
}

function stripNarrowEdition(title: string): string {
    let stripped = title.trim();
    if (title.length > MAX_EDITION_TITLE_LENGTH) return stripped;
    for (let count = 0; count < MAX_EDITION_GROUPS; count += 1) {
        const match = trailingEditionGroup(stripped);
        if (!match) break;
        const group = match[1] ?? match[2] ?? match[3] ?? "";
        if (!isEditionGroup(group)) break;
        stripped = stripped.slice(0, match.index).trim();
    }
    return stripped;
}

function exactKey(value: string): string | null {
    if (!value.trim()) return null;
    return normalizeForExactKey(value) || null;
}

function titleTier(requested: string, candidate: string): MatchTier | null {
    const requestedExact = exactKey(requested);
    const candidateExact = exactKey(candidate);
    if (!requestedExact || !candidateExact) return null;
    if (requestedExact === candidateExact) return "exact";
    const requestedEdition = exactKey(stripNarrowEdition(requested));
    const candidateEdition = exactKey(stripNarrowEdition(candidate));
    return requestedEdition && requestedEdition === candidateEdition
        ? "edition"
        : null;
}

function supportedPrimaryType(value: string): SupportedPrimaryType | null {
    const normalized = value.trim().toLowerCase();
    return (
        PRIMARY_TYPES.find((type) => type.toLowerCase() === normalized) ?? null
    );
}

function scoreIsEligible(score: number | undefined): boolean {
    return score === undefined || (Number.isFinite(score) && score >= 90);
}

function eligibleTieredCandidates(
    albumTitle: string,
    candidates: readonly RemoteAlbumMbidCandidate[],
): TieredCandidate[] {
    return candidates.flatMap((candidate) => {
        if (!candidate.artistMatches || !isValidMbid(candidate.rgMbid)) {
            return [];
        }
        const tier = titleTier(albumTitle, candidate.title);
        return tier ? [{ ...candidate, tier }] : [];
    });
}

function rankCandidate(
    candidate: TieredCandidate,
    options: RemoteAlbumMbidMatchOptions,
): RankedCandidate | null {
    const primaryType = supportedPrimaryType(candidate.primaryType);
    if (!primaryType || !scoreIsEligible(candidate.score)) return null;
    if (primaryType === "Single" && !options.allowSingle) return null;
    return { rgMbid: candidate.rgMbid, tier: candidate.tier, primaryType };
}

function uniqueBucketMatch(
    candidates: readonly RankedCandidate[],
    primaryType: SupportedPrimaryType,
): RemoteAlbumMbidMatch | null | undefined {
    const bucket = candidates.filter(
        (candidate) => candidate.primaryType === primaryType,
    );
    if (bucket.length === 0) return undefined;
    const identities = new Set(bucket.map((candidate) => candidate.rgMbid));
    return identities.size === 1 ? bucket[0] : null;
}

/** Select one unambiguous MusicBrainz release group by title tier and type. */
export function pickRemoteAlbumMbidMatch(
    albumTitle: string,
    candidates: readonly RemoteAlbumMbidCandidate[],
    options: RemoteAlbumMbidMatchOptions,
): RemoteAlbumMbidMatch | null {
    const tiered = eligibleTieredCandidates(albumTitle, candidates);
    const tier: MatchTier = tiered.some(
        (candidate) => candidate.tier === "exact",
    )
        ? "exact"
        : "edition";
    const ranked = tiered
        .filter((candidate) => candidate.tier === tier)
        .map((candidate) => rankCandidate(candidate, options))
        .filter(
            (candidate): candidate is RankedCandidate => candidate !== null,
        );
    for (const primaryType of PRIMARY_TYPES) {
        const match = uniqueBucketMatch(ranked, primaryType);
        if (match !== undefined) return match;
    }
    return null;
}
