import type { Track } from "./audio-state-context";
import { isRemoteTrack } from "./trackRef";

export type ShareResourceType = "playlist" | "album" | "track";

export function canShareTrack(track: Track): boolean {
    return Boolean(track.id) && !isRemoteTrack(track);
}

export function buildAbsoluteShareUrl(accessPath: string, origin: string): string {
    return new URL(accessPath, origin).toString();
}
