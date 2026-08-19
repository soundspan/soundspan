import { isMainThread, parentPort, workerData } from "worker_threads";
import type { PrismaClient } from "@prisma/client";
import { UMAP } from "umap-js";
import { createPrismaClient } from "../utils/prismaClientFactory";
import { parseEmbedding } from "../utils/embedding";
import { TRACK_BROWSE_SQL } from "../utils/libraryRadioPredicates";
import {
    MAX_UMAP_WORKER_ROWS,
    type UmapProjectionRow,
    type UmapWorkerData,
    type UmapWorkerMessage,
} from "./umapWorkerProtocol";

type MaterializedRow = UmapProjectionRow & { embedding: string };

function validateWorkerData(value: unknown): UmapWorkerData {
    const candidate = value as Partial<UmapWorkerData> | null;
    if (
        !candidate ||
        typeof candidate.spaceId !== "string" ||
        candidate.spaceId.length < 1 ||
        candidate.spaceId.length > 200 ||
        !Number.isSafeInteger(candidate.sampleSize) ||
        Number(candidate.sampleSize) < 1 ||
        Number(candidate.sampleSize) > MAX_UMAP_WORKER_ROWS
    ) {
        throw new Error("Invalid UMAP worker data");
    }
    return candidate as UmapWorkerData;
}

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

/** Parse embedding text and run the same UMAP fit used by the prior parent path. */
export function projectEmbeddingTexts(
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
    return fitEmbeddings(embeddings, nNeighbors);
}

function fitEmbeddings(embeddings: number[][], nNeighbors: number): number[][] {
    const umap = new UMAP({
        nComponents: 2,
        nNeighbors,
        minDist: 0.1,
        spread: 1.0,
    });
    return umap.fit(embeddings);
}

function stripEmbeddingRows(
    materializedRows: MaterializedRow[],
): UmapProjectionRow[] {
    return materializedRows.map(({ embedding: _embedding, ...row }) => row);
}

function postMessage(message: UmapWorkerMessage): void {
    if (!parentPort) throw new Error("UMAP worker has no parent port");
    parentPort.postMessage(message);
}

async function runWorkerTask(data: UmapWorkerData): Promise<void> {
    const database = createPrismaClient({
        connectionLimit: 1,
        poolTimeoutSeconds: 30,
    });
    try {
        const materializedRows = await loadRows(database, data);
        postMessage({
            type: "materialized",
            rowCount: materializedRows.length,
        });
        if (materializedRows.length < 5) {
            postMessage({
                type: "result",
                rows: stripEmbeddingRows(materializedRows),
                projection: null,
            });
            return;
        }
        const nNeighbors = Math.min(
            15,
            Math.max(2, Math.floor(materializedRows.length / 2)),
        );
        const embeddingTexts = materializedRows.map((row) => row.embedding);
        const rows = stripEmbeddingRows(materializedRows);
        materializedRows.length = 0;
        const projection = projectEmbeddingTexts(embeddingTexts, nNeighbors);
        postMessage({ type: "result", rows, projection });
    } finally {
        await database.$disconnect();
    }
}

if (!isMainThread) {
    const data = validateWorkerData(workerData);
    runWorkerTask(data).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        postMessage({ type: "error", error: message.slice(0, 500) });
        process.exitCode = 1;
    });
}
