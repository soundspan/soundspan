/** Maximum number of projection rows accepted from one bounded worker. */
export const MAX_UMAP_WORKER_ROWS = 15_000;

/** Query parameters passed to the bounded UMAP worker. */
export interface UmapWorkerData {
    spaceId: string;
    sampleSize: number;
}

/** Track metadata returned after embeddings have been discarded in the worker. */
export interface UmapProjectionRow {
    track_id: string;
    title: string;
    artistName: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    loudnessLufs: number | null;
    truePeakDb: number | null;
    albumLoudnessLufs: number | null;
    albumTruePeakDb: number | null;
    energy: number | null;
    valence: number | null;
    moodHappy: number | null;
    moodSad: number | null;
    moodRelaxed: number | null;
    moodAggressive: number | null;
    moodParty: number | null;
    moodAcoustic: number | null;
    moodElectronic: number | null;
}

/** Messages emitted by the bounded UMAP worker. */
export type UmapWorkerMessage =
    | { type: "materialized"; rowCount: number }
    | {
          type: "result";
          rows: UmapProjectionRow[];
          projection: number[][] | null;
      }
    | { type: "error"; error: string };
