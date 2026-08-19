import type { PrismaClient } from "@prisma/client";
import { UMAP } from "umap-js";
import { parseEmbedding } from "../utils/embedding";
import { TRACK_BROWSE_SQL } from "../utils/libraryRadioPredicates";
import { createPrismaClient } from "../utils/prismaClientFactory";
import {
    MAX_UMAP_WORKER_ROWS,
    type UmapProjectionRow,
    type UmapWorkerData,
    type UmapWorkerMessage,
} from "./umapWorkerProtocol";

type MaterializedRow = UmapProjectionRow & { embedding: string };

async function loadRows(
    database: PrismaClient,
    data: UmapWorkerData,
): Promise<MaterializedRow[]> {
    return database.$queryRaw<MaterializedRow[]>`
        SELECT
            te.track_id,
            t.title,
            ar.name as "artistName",
            ar.id as "artistId",
            a.id as "albumId",
            a."coverUrl",
            t."loudnessLufs",
            t."truePeakDb",
            a."albumLoudnessLufs",
            a."albumTruePeakDb",
            t.energy,
            t.valence,
            t."moodHappy",
            t."moodSad",
            t."moodRelaxed",
            t."moodAggressive",
            t."moodParty",
            t."moodAcoustic",
            t."moodElectronic",
            te.embedding::text as embedding
        FROM track_embeddings te
        JOIN "Track" t ON te.track_id = t.id
        JOIN "Album" a ON t."albumId" = a.id
        JOIN "Artist" ar ON a."artistId" = ar.id
        WHERE t."removedAt" IS NULL
          AND ${TRACK_BROWSE_SQL}
          AND te.space_id = ${data.spaceId}
        ORDER BY RANDOM()
        LIMIT ${data.sampleSize}
    `;
}

function fitEmbeddingTexts(
    embeddingTexts: string[],
    nNeighbors: number,
): number[][] {
    if (embeddingTexts.length > MAX_UMAP_WORKER_ROWS) {
        throw new RangeError("UMAP embedding input exceeds its row bound");
    }
    const embeddings = new Array<number[]>(embeddingTexts.length);
    for (let index = 0; index < MAX_UMAP_WORKER_ROWS; index += 1) {
        if (index >= embeddingTexts.length) break;
        embeddings[index] = parseEmbedding(embeddingTexts[index]);
    }
    return new UMAP({
        nComponents: 2,
        nNeighbors,
        minDist: 0.1,
        spread: 1.0,
    }).fit(embeddings);
}

function stripEmbeddings(rows: MaterializedRow[]): UmapProjectionRow[] {
    return rows.map(({ embedding: _embedding, ...row }) => row);
}

async function materializeAndPublish(
    database: PrismaClient,
    data: UmapWorkerData,
    publish: (message: UmapWorkerMessage) => void,
): Promise<void> {
    const materializedRows = await loadRows(database, data);
    publish({ type: "materialized", rowCount: materializedRows.length });
    if (materializedRows.length < 5) {
        publish({
            type: "result",
            rows: stripEmbeddings(materializedRows),
            projection: null,
        });
        return;
    }
    const embeddingTexts = materializedRows.map((row) => row.embedding);
    const rows = stripEmbeddings(materializedRows);
    materializedRows.length = 0;
    const nNeighbors = Math.min(15, Math.max(2, Math.floor(rows.length / 2)));
    const projection = fitEmbeddingTexts(embeddingTexts, nNeighbors);
    publish({ type: "result", rows, projection });
}

/** Query projection rows, fit UMAP, publish progress, and always disconnect. */
export async function runUmapMaterialization(
    data: UmapWorkerData,
    publish: (message: UmapWorkerMessage) => void,
    createDatabase: () => PrismaClient = () =>
        createPrismaClient({ connectionLimit: 1, poolTimeoutSeconds: 30 }),
): Promise<void> {
    const database = createDatabase();
    try {
        await materializeAndPublish(database, data, publish);
    } finally {
        await database.$disconnect();
    }
}
