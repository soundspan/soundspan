import { isMainThread, parentPort, workerData } from "worker_threads";
import {
    MAX_UMAP_WORKER_ROWS,
    type UmapWorkerData,
    type UmapWorkerMessage,
} from "./umapWorkerProtocol";
import { runUmapMaterialization } from "./umapMaterialization";

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

function postMessage(message: UmapWorkerMessage): void {
    if (!parentPort) throw new Error("UMAP worker has no parent port");
    parentPort.postMessage(message);
}

if (!isMainThread) {
    const data = validateWorkerData(workerData);
    runUmapMaterialization(data, postMessage).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        postMessage({ type: "error", error: message.slice(0, 500) });
        process.exitCode = 1;
    });
}
