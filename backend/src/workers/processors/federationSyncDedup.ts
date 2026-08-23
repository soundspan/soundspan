import { prisma } from "../../utils/db";
import { chunkArray } from "../../utils/async";
import { type RemoteAlbumRow, type TrackEnvelope } from "./federationSyncPage";

const POSITION_DEDUP_CHUNK_SIZE = 100;
const LOCAL_DEDUP_WHERE = { origin: "LOCAL" as const, removedAt: null };

/** A local track selected by federation dedup, with its match confidence. */
export type DedupMatch = { id: string; confidence: number };

interface DedupIndex {
    audioHash: Map<string, string>;
    recordingMbid: Map<string, string>;
    isrc: Map<string, string>;
    position: Map<string, string>;
}

interface LocalAlbumLookup {
    albumIdByRgMbid: ReadonlyMap<string, string>;
    rgMbidByAlbumId: ReadonlyMap<string, string>;
}

interface PositionTuple {
    albumId: string;
    discNo: number;
    trackNo: number;
}

function uniqueValues(values: Array<string | null>): string[] {
    return [
        ...new Set(values.filter((value): value is string => Boolean(value))),
    ];
}

function setFirst(map: Map<string, string>, key: string, id: string): void {
    if (!map.has(key)) map.set(key, id);
}

function positionKey(rgMbid: string, discNo: number, trackNo: number): string {
    return JSON.stringify([rgMbid, discNo, trackNo]);
}

async function loadAudioDedupMatches(
    tracks: readonly TrackEnvelope[],
    target: Map<string, string>,
): Promise<void> {
    const values = uniqueValues(
        tracks.map((item) => item.attributes.audioHash),
    );
    if (values.length === 0) return;
    const rows = await prisma.track.findMany({
        where: { ...LOCAL_DEDUP_WHERE, audioHash: { in: values } },
        orderBy: { id: "asc" },
        select: { id: true, audioHash: true },
    });
    for (const row of rows) {
        if (row.audioHash) setFirst(target, row.audioHash, row.id);
    }
}

async function loadRecordingDedupMatches(
    tracks: readonly TrackEnvelope[],
    target: Map<string, string>,
): Promise<void> {
    const values = uniqueValues(
        tracks.map((item) => item.attributes.recordingMbid),
    );
    if (values.length === 0) return;
    const rows = await prisma.track.findMany({
        where: { ...LOCAL_DEDUP_WHERE, recordingMbid: { in: values } },
        orderBy: { id: "asc" },
        select: { id: true, recordingMbid: true },
    });
    for (const row of rows) {
        if (row.recordingMbid) {
            setFirst(target, row.recordingMbid, row.id);
        }
    }
}

async function loadIsrcDedupMatches(
    tracks: readonly TrackEnvelope[],
    target: Map<string, string>,
): Promise<void> {
    const values = uniqueValues(tracks.map((item) => item.attributes.isrc));
    if (values.length === 0) return;
    const rows = await prisma.track.findMany({
        where: { ...LOCAL_DEDUP_WHERE, isrc: { in: values } },
        orderBy: { id: "asc" },
        select: { id: true, isrc: true },
    });
    for (const row of rows) {
        if (row.isrc) setFirst(target, row.isrc, row.id);
    }
}

function requestedAlbumRgMbids(
    tracks: readonly TrackEnvelope[],
    albums: ReadonlyMap<string, RemoteAlbumRow>,
): string[] {
    return uniqueValues(
        tracks.map((item) => albums.get(item.parentRef)?.rgMbid ?? null),
    );
}

async function loadLocalAlbums(rgMbids: string[]): Promise<LocalAlbumLookup> {
    const rows = await prisma.album.findMany({
        where: { rgMbid: { in: rgMbids }, location: "LIBRARY" },
        select: { id: true, rgMbid: true },
    });
    const albumIdByRgMbid = new Map<string, string>();
    const rgMbidByAlbumId = new Map<string, string>();
    for (const row of rows) {
        albumIdByRgMbid.set(row.rgMbid, row.id);
        rgMbidByAlbumId.set(row.id, row.rgMbid);
    }
    return { albumIdByRgMbid, rgMbidByAlbumId };
}

function buildPositionTuples(
    tracks: readonly TrackEnvelope[],
    albums: ReadonlyMap<string, RemoteAlbumRow>,
    albumIdByRgMbid: ReadonlyMap<string, string>,
): PositionTuple[] {
    const tuples = new Map<string, PositionTuple>();
    for (const item of tracks) {
        const rgMbid = albums.get(item.parentRef)?.rgMbid;
        const albumId = rgMbid ? albumIdByRgMbid.get(rgMbid) : undefined;
        if (!albumId) continue;
        const tuple = {
            albumId,
            discNo: item.attributes.discNo,
            trackNo: item.attributes.trackNo,
        };
        const key = positionKey(albumId, tuple.discNo, tuple.trackNo);
        if (!tuples.has(key)) tuples.set(key, tuple);
    }
    return [...tuples.values()];
}

async function loadPositionChunk(
    tuples: PositionTuple[],
    rgMbidByAlbumId: ReadonlyMap<string, string>,
    target: Map<string, string>,
): Promise<void> {
    const rows = await prisma.track.findMany({
        where: { ...LOCAL_DEDUP_WHERE, OR: tuples },
        orderBy: { id: "asc" },
        select: { id: true, albumId: true, discNo: true, trackNo: true },
    });
    for (const row of rows) {
        const rgMbid = rgMbidByAlbumId.get(row.albumId);
        if (!rgMbid) continue;
        const key = positionKey(rgMbid, row.discNo, row.trackNo);
        setFirst(target, key, row.id);
    }
}

async function loadPositionDedupMatches(
    tracks: readonly TrackEnvelope[],
    albums: ReadonlyMap<string, RemoteAlbumRow>,
    target: Map<string, string>,
): Promise<void> {
    const rgMbids = requestedAlbumRgMbids(tracks, albums);
    if (rgMbids.length === 0) return;
    const lookup = await loadLocalAlbums(rgMbids);
    const tuples = buildPositionTuples(tracks, albums, lookup.albumIdByRgMbid);
    for (const chunk of chunkArray(tuples, POSITION_DEDUP_CHUNK_SIZE)) {
        await loadPositionChunk(chunk, lookup.rgMbidByAlbumId, target);
    }
}

/** Loads all local-track identity indexes used for one federation page. */
export async function loadDedupIndex(
    tracks: readonly TrackEnvelope[],
    albums: ReadonlyMap<string, RemoteAlbumRow>,
): Promise<DedupIndex> {
    const index: DedupIndex = {
        audioHash: new Map(),
        recordingMbid: new Map(),
        isrc: new Map(),
        position: new Map(),
    };
    await loadAudioDedupMatches(tracks, index.audioHash);
    await loadRecordingDedupMatches(tracks, index.recordingMbid);
    await loadIsrcDedupMatches(tracks, index.isrc);
    await loadPositionDedupMatches(tracks, albums, index.position);
    return index;
}

/** Selects the highest-confidence local match from a loaded dedup index. */
export function findDedupMatch(
    index: DedupIndex,
    item: TrackEnvelope,
    albumRgMbid: string,
): DedupMatch | null {
    const attributes = item.attributes;
    const audio = attributes.audioHash
        ? index.audioHash.get(attributes.audioHash)
        : undefined;
    if (audio) return { id: audio, confidence: 1 };
    const recording = attributes.recordingMbid
        ? index.recordingMbid.get(attributes.recordingMbid)
        : undefined;
    if (recording) return { id: recording, confidence: 0.95 };
    const isrc = attributes.isrc ? index.isrc.get(attributes.isrc) : undefined;
    if (isrc) return { id: isrc, confidence: 0.9 };
    const positional = index.position.get(
        positionKey(albumRgMbid, attributes.discNo, attributes.trackNo),
    );
    return positional ? { id: positional, confidence: 0.8 } : null;
}
