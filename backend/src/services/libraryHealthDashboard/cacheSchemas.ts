import { z } from "zod";
import type { LibraryHealthCachePanel } from "../../metrics/libraryHealthMetrics";
import { DUPLICATE_CLUSTER_MEMBER_PREVIEW_LIMIT } from "./constants";

const nonnegativeInteger = z.number().int().nonnegative();
const nonnegativeNumber = z.number().nonnegative();
const nullableString = z.string().nullable();
const statusCountsSchema = z.strictObject({
    pending: nonnegativeInteger,
    processing: nonnegativeInteger,
    failed: nonnegativeInteger,
    completed: nonnegativeInteger,
});
const duplicateTierCountsSchema = z.strictObject({
    audioHash: nonnegativeInteger,
    recordingMbid: nonnegativeInteger,
    isrc: nonnegativeInteger,
});

const summarySchema = z.strictObject({
    metadataGaps: z.strictObject({
        missingArt: z.strictObject({
            albums: nonnegativeInteger,
            artists: nonnegativeInteger,
        }),
        missingMbid: z.strictObject({
            albums: nonnegativeInteger,
            artists: nonnegativeInteger,
        }),
        missingGenres: nonnegativeInteger,
        missingLyrics: nonnegativeInteger,
    }),
    analysisCoverage: z.strictObject({
        total: nonnegativeInteger,
        analysisStatus: statusCountsSchema,
        vibeAnalysisStatus: statusCountsSchema,
        loudness: z.strictObject({
            measured: nonnegativeInteger,
            missing: nonnegativeInteger,
        }),
    }),
    storage: z.strictObject({
        tracks: nonnegativeInteger,
        totalFileSize: nonnegativeNumber,
        mimeTypes: nonnegativeInteger,
        artists: nonnegativeInteger,
        isTruncated: z.boolean(),
    }),
    quality: z.strictObject({
        floorKbps: nonnegativeNumber,
        albumsBelowFloor: nonnegativeInteger,
        isTruncated: z.boolean(),
    }),
    duplicates: z.strictObject({
        clusters: nonnegativeInteger,
        byTier: duplicateTierCountsSchema,
        isTruncated: z.boolean(),
    }),
});

const storageSchema = z.strictObject({
    formats: z.array(
        z.strictObject({
            mime: nullableString,
            trackCount: nonnegativeInteger,
            totalFileSize: nonnegativeNumber,
            averageBitrateKbps: nonnegativeNumber.nullable(),
            bitrateSampleSize: nonnegativeInteger,
        }),
    ),
    topArtists: z.array(
        z.strictObject({
            artistId: z.string(),
            artistName: z.string(),
            trackCount: nonnegativeInteger,
            totalFileSize: nonnegativeNumber,
        }),
    ),
    sampledTracks: nonnegativeInteger,
    sampleLimit: nonnegativeInteger,
    isTruncated: z.boolean(),
});

const qualitySchema = z.strictObject({
    albums: z.array(
        z.strictObject({
            albumId: z.string(),
            title: z.string(),
            artist: z.strictObject({ id: z.string(), name: z.string() }),
            averageBitrateKbps: nonnegativeNumber,
            trackCount: nonnegativeInteger,
        }),
    ),
    sampledTracks: nonnegativeInteger,
    sampleLimit: nonnegativeInteger,
    isTruncated: z.boolean(),
});

const duplicateClusterSchema = z
    .strictObject({
        tier: z.enum(["audioHash", "recordingMbid", "isrc"]),
        identity: z.string(),
        memberCount: z.number().int().min(2),
        totalFileSize: nonnegativeNumber,
        members: z
            .array(
                z.strictObject({
                    id: z.string(),
                    title: z.string(),
                    albumTitle: z.string(),
                    artistName: z.string(),
                    filePath: nullableString,
                    fileSize: nonnegativeNumber,
                    mime: nullableString,
                }),
            )
            .min(1)
            .max(DUPLICATE_CLUSTER_MEMBER_PREVIEW_LIMIT),
    })
    .superRefine((cluster, context) => {
        const expectedPreviewCount = Math.min(
            cluster.memberCount,
            DUPLICATE_CLUSTER_MEMBER_PREVIEW_LIMIT,
        );
        if (cluster.members.length !== expectedPreviewCount) {
            context.addIssue({
                code: "custom",
                path: ["members"],
                message: "Duplicate preview does not match member count",
            });
        }
    });

const duplicatesSchema = z
    .strictObject({
        clusters: z.array(duplicateClusterSchema),
        total: nonnegativeInteger,
        byTier: duplicateTierCountsSchema,
        isTruncated: z.boolean(),
    })
    .superRefine((catalog, context) => {
        if (catalog.total !== catalog.clusters.length) {
            context.addIssue({
                code: "custom",
                path: ["total"],
                message: "Duplicate total does not match cluster count",
            });
        }
        for (const tier of ["audioHash", "recordingMbid", "isrc"] as const) {
            const actual = catalog.clusters.filter(
                (cluster) => cluster.tier === tier,
            ).length;
            if (catalog.byTier[tier] !== actual) {
                context.addIssue({
                    code: "custom",
                    path: ["byTier", tier],
                    message: `Duplicate ${tier} count does not match clusters`,
                });
            }
        }
    });

/** Strict payload validators keyed by the versioned Library Health panel cache. */
export const LIBRARY_HEALTH_CACHE_SCHEMAS = {
    summary: summarySchema,
    storage: storageSchema,
    quality: qualitySchema,
    duplicates: duplicatesSchema,
} as const satisfies Record<LibraryHealthCachePanel, z.ZodType>;

const cacheGenerationSchema = z.string().regex(/^(0|[1-9]\d*)$/);

/** Strict generation-bearing envelopes keyed by Library Health panel. */
export const LIBRARY_HEALTH_CACHE_ENVELOPE_SCHEMAS = {
    summary: z.strictObject({
        generation: cacheGenerationSchema,
        payload: summarySchema,
    }),
    storage: z.strictObject({
        generation: cacheGenerationSchema,
        payload: storageSchema,
    }),
    quality: z.strictObject({
        generation: cacheGenerationSchema,
        payload: qualitySchema,
    }),
    duplicates: z.strictObject({
        generation: cacheGenerationSchema,
        payload: duplicatesSchema,
    }),
} as const satisfies Record<LibraryHealthCachePanel, z.ZodType>;
