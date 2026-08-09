import type { Prisma } from "@prisma/client";

/**
 * Declarative definition of a "curated daily vibe mix". These mixes all share
 * the same generation pipeline (filter completed-analysis tracks, apply
 * artist-diversity selection, build a 10-track mix); only the query filter and
 * presentation metadata differ. Centralizing them here keeps the catalog
 * data-driven instead of duplicated across ~13 near-identical methods.
 */
export interface CuratedVibeMixDefinition {
    /** Stable mix type/slug; also the id prefix (`${type}-${today}`). */
    type: string;
    /** Human-readable mix name. */
    name: string;
    /** Short description shown in the UI. */
    description: string;
    /** Key into the mix color palette (see getMixColor). */
    colorKey: string;
    /** Prisma `take` for the candidate pool query. */
    take: number;
    /** Prisma filter (merged with `analysisStatus: "completed"`). */
    where: Prisma.TrackWhereInput;
    /**
     * Optional minimum candidate pool size before a mix is produced.
     * Defaults to the service's daily minimum when omitted.
     */
    minTracks?: number;
    /**
     * Optional day-of-week gate (0 = Sunday). When set, the mix is only
     * generated on that weekday.
     */
    dayOfWeek?: number;
}

/** The full curated daily vibe mix catalog. */
export const CURATED_VIBE_MIXES: readonly CuratedVibeMixDefinition[] = [
    {
        type: "sad-girl-sundays",
        name: "Sad Girl Sundays",
        description: "Melancholic introspection and feelings",
        colorKey: "sad-girl-sundays",
        take: 50,
        dayOfWeek: 0,
        where: {
            OR: [
                { AND: [{ valence: { lte: 0.35 } }, { keyScale: "minor" }] },
                { AND: [{ valence: { lte: 0.3 } }, { arousal: { lte: 0.4 } }] },
                {
                    lastfmTags: {
                        hasSome: ["sad", "melancholic", "heartbreak", "emotional"],
                    },
                },
            ],
        },
    },
    {
        type: "main-character",
        name: "Main Character Energy",
        description: "You're the protagonist today",
        colorKey: "main-character",
        take: 50,
        where: {
            OR: [
                {
                    AND: [
                        { valence: { gte: 0.55 } },
                        { energy: { gte: 0.55 } },
                        { danceability: { gte: 0.5 } },
                    ],
                },
                {
                    lastfmTags: {
                        hasSome: ["empowering", "confident", "uplifting", "anthemic"],
                    },
                },
            ],
        },
    },
    {
        type: "villain-era",
        name: "Villain Era",
        description: "Embrace your dark side",
        colorKey: "villain-era",
        take: 50,
        where: {
            OR: [
                { AND: [{ keyScale: "minor" }, { energy: { gte: 0.65 } }] },
                { moodTags: { hasSome: ["aggressive", "dark", "intense"] } },
                {
                    lastfmTags: {
                        hasSome: ["dark", "aggressive", "intense", "powerful"],
                    },
                },
            ],
        },
    },
    {
        type: "3am-thoughts",
        name: "3AM Thoughts",
        description: "Late night overthinking companion",
        colorKey: "3am-thoughts",
        take: 50,
        where: {
            AND: [
                { arousal: { lte: 0.4 } },
                { energy: { lte: 0.5 } },
                { bpm: { lte: 110 } },
                {
                    OR: [
                        { valence: { lte: 0.5 } },
                        { acousticness: { gte: 0.3 } },
                    ],
                },
            ],
        },
    },
    {
        type: "hot-girl-walk",
        name: "Hot Girl Walk",
        description: "Confidence boost for your walk",
        colorKey: "confidence-boost",
        take: 50,
        where: {
            OR: [
                {
                    AND: [
                        { danceability: { gte: 0.65 } },
                        { bpm: { gte: 95, lte: 135 } },
                        { energy: { gte: 0.55 } },
                    ],
                },
                { AND: [{ valence: { gte: 0.6 } }, { energy: { gte: 0.6 } }] },
            ],
        },
    },
    {
        type: "rage-cleaning",
        name: "Rage Cleaning",
        description: "Aggressive productivity fuel",
        colorKey: "workout",
        take: 50,
        where: {
            OR: [
                {
                    AND: [
                        { energy: { gte: 0.75 } },
                        { arousal: { gte: 0.65 } },
                        { bpm: { gte: 125 } },
                    ],
                },
                {
                    AND: [
                        { energy: { gte: 0.8 } },
                        { danceability: { gte: 0.6 } },
                    ],
                },
                { moodTags: { hasSome: ["aggressive", "energetic"] } },
            ],
        },
    },
    {
        type: "golden-hour",
        name: "Golden Hour",
        description: "Warm sunset vibes",
        colorKey: "golden-hour",
        take: 50,
        where: {
            OR: [
                {
                    AND: [
                        { valence: { gte: 0.45 } },
                        { acousticness: { gte: 0.35 } },
                        { energy: { gte: 0.25, lte: 0.65 } },
                    ],
                },
                {
                    lastfmTags: {
                        hasSome: ["warm", "sunset", "dreamy", "peaceful"],
                    },
                },
            ],
        },
    },
    {
        type: "shower-karaoke",
        name: "Shower Karaoke",
        description: "Belters you can't help but sing",
        colorKey: "happy",
        take: 50,
        where: {
            AND: [
                { instrumentalness: { lte: 0.35 } },
                { energy: { gte: 0.55 } },
                { valence: { gte: 0.45 } },
            ],
        },
    },
    {
        type: "in-my-feelings",
        name: "In My Feelings",
        description: "Let it all out",
        colorKey: "heartbreak-hotel",
        take: 50,
        where: {
            OR: [
                {
                    AND: [
                        { valence: { lte: 0.4 } },
                        { arousal: { lte: 0.55 } },
                        { acousticness: { gte: 0.25 } },
                    ],
                },
                {
                    lastfmTags: {
                        hasSome: ["emotional", "heartbreak", "feelings", "vulnerable"],
                    },
                },
            ],
        },
    },
    {
        type: "midnight-drive",
        name: "Midnight Drive",
        description: "Perfect for late night cruising",
        colorKey: "night-drive",
        take: 50,
        where: {
            AND: [
                { energy: { gte: 0.3, lte: 0.65 } },
                { bpm: { gte: 80, lte: 130 } },
                {
                    OR: [
                        { arousal: { lte: 0.6 } },
                        { valence: { gte: 0.3, lte: 0.7 } },
                    ],
                },
            ],
        },
    },
    {
        type: "romanticize",
        name: "Romanticize Your Life",
        description: "Make every moment aesthetic",
        colorKey: "golden-hour",
        take: 50,
        where: {
            OR: [
                {
                    AND: [
                        { valence: { gte: 0.35, lte: 0.75 } },
                        { arousal: { gte: 0.25, lte: 0.65 } },
                        { acousticness: { gte: 0.25 } },
                    ],
                },
                {
                    lastfmTags: {
                        hasSome: ["dreamy", "aesthetic", "cinematic", "romantic"],
                    },
                },
            ],
        },
    },
    {
        type: "that-girl-era",
        name: "That Girl Era",
        description: "Self-improvement mode activated",
        colorKey: "confidence-boost",
        take: 50,
        where: {
            AND: [
                { valence: { gte: 0.55 } },
                { energy: { gte: 0.45 } },
                { danceability: { gte: 0.45 } },
            ],
        },
    },
    {
        type: "unhinged",
        name: "Unhinged",
        description: "Embrace the chaos",
        colorKey: "dance-floor",
        take: 100,
        where: {
            OR: [
                { energy: { gte: 0.85 } },
                { energy: { lte: 0.15 } },
                { valence: { gte: 0.9 } },
                { valence: { lte: 0.1 } },
                { bpm: { gte: 160 } },
                { bpm: { lte: 70 } },
                { danceability: { gte: 0.9 } },
            ],
        },
    },
];

/** Lookup of curated vibe mix definitions by their `type`. */
export const CURATED_VIBE_MIXES_BY_TYPE: Readonly<
    Record<string, CuratedVibeMixDefinition>
> = Object.fromEntries(
    CURATED_VIBE_MIXES.map((definition) => [definition.type, definition])
);
