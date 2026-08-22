"use client";

import { Network } from "lucide-react";
import type {
    PeerPresenceSnapshot,
    PeerPresenceUser,
    SocialListeningStatus,
} from "@/hooks/useSocialPresence";

function formatSnapshotAge(isoDate: string): string {
    const parsed = Date.parse(isoDate);
    if (Number.isNaN(parsed)) return "recently";
    const diffMs = Date.now() - parsed;
    if (diffMs < 60_000) return "moments ago";
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
    return `${Math.floor(diffMs / 3_600_000)}h ago`;
}

const statusDotClass: Record<SocialListeningStatus, string> = {
    playing: "bg-green-400",
    paused: "bg-amber-400",
    idle: "bg-white/40",
};

function PeerUserRow({ user }: { user: PeerPresenceUser }) {
    const name = user.displayName || user.username;
    const showTrack = user.status !== "idle" && Boolean(user.track);
    return (
        <div
            role="listitem"
            className="px-3 py-2 border-b border-white/5 flex items-start gap-3"
        >
            <div className="w-7 h-7 rounded-full bg-white/10 text-white/70 text-xs font-semibold flex items-center justify-center shrink-0">
                {name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
                <div className="flex items-center gap-2">
                    <span className="text-sm text-white/80 truncate">
                        {name}
                    </span>
                    <span
                        className={`w-1.5 h-1.5 rounded-full ${statusDotClass[user.status]}`}
                        aria-hidden
                    />
                </div>
                {showTrack && user.track && (
                    <p className="text-xs text-white/40 truncate">
                        {user.track.title} — {user.track.artist}
                    </p>
                )}
            </div>
        </div>
    );
}

/**
 * Renders online users from federated peers, grouped by their home
 * server, with honest freshness labeling — peer presence updates on the
 * sync cadence (minutes), not in realtime.
 */
export function PeerPresenceSection({
    peers,
}: {
    peers: PeerPresenceSnapshot[];
}) {
    const withUsers = peers.filter((peer) => peer.users.length > 0);
    if (withUsers.length === 0) return null;
    return (
        <div aria-label="Online users from federated peers">
            {withUsers.map((peer) => (
                <section key={peer.peerId}>
                    <div className="flex items-center justify-between px-3 py-2 border-b border-white/5 bg-white/[0.02]">
                        <span className="flex items-center gap-1.5 text-xs text-white/50">
                            <Network className="w-3.5 h-3.5" />
                            From {peer.peerName}
                        </span>
                        <span className="text-xs text-white/30">
                            updated {formatSnapshotAge(peer.fetchedAt)}
                        </span>
                    </div>
                    <div role="list" aria-label={`Users on ${peer.peerName}`}>
                        {peer.users.map((user) => (
                            <PeerUserRow
                                key={`${peer.peerId}:${user.username}`}
                                user={user}
                            />
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}
