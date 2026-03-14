import { parentPort, workerData } from "worker_threads";
import { UMAP } from "umap-js";

const { embeddings, nNeighbors } = workerData as {
    embeddings: number[][];
    nNeighbors: number;
};

try {
    const umap = new UMAP({
        nComponents: 2,
        nNeighbors,
        minDist: 0.1,
        spread: 1.0,
    });

    const projection = umap.fit(embeddings);
    parentPort?.postMessage(projection);
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    parentPort?.postMessage({ error: message });
    process.exit(1);
}
