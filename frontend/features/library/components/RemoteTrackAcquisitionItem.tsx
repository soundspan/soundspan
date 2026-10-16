"use client";

import { Download, Send } from "lucide-react";
import { TrackMenuButton } from "@/components/ui/TrackOverflowMenu";
import {
    getRemoteTrackAcquisitionLabel,
    resolveRemoteTrackAcquisition,
    type RemoteTrackAcquisition,
    type RemoteTrackAcquisitionPolicy,
} from "../remoteTrackAcquisition";
import type { Track } from "../types";

interface RemoteTrackAcquisitionItemProps {
    track: Track;
    policy: RemoteTrackAcquisitionPolicy;
    onAcquire?: (action: RemoteTrackAcquisition) => void;
}

/**
 * Track-menu item that brings a liked streaming song into the library
 * ("Add album to library", "Request album", or "Add song to library").
 * Renders nothing when the viewer has no way to do that for this song.
 */
export function RemoteTrackAcquisitionItem({
    track,
    policy,
    onAcquire,
}: RemoteTrackAcquisitionItemProps) {
    if (!onAcquire) return null;
    const action = resolveRemoteTrackAcquisition(track, policy);
    if (!action) return null;
    const Icon = action.kind === "request-album" ? Send : Download;
    return (
        <TrackMenuButton
            onClick={(e) => {
                e.stopPropagation();
                onAcquire(action);
            }}
            icon={<Icon className="h-4 w-4" />}
            label={getRemoteTrackAcquisitionLabel(action)}
        />
    );
}
