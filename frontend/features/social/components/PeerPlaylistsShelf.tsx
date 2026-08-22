"use client";

import Link from "next/link";
import { ListMusic, Network } from "lucide-react";
import { usePeerPlaylists } from "@/features/social/hooks/usePeerPlaylists";

/**
 * Home shelf listing public playlists shared by federated peers, badged
 * by their home server. Renders nothing when no peer shares playlists.
 */
export function PeerPlaylistsShelf() {
    const { playlists, enabled } = usePeerPlaylists();
    if (!enabled || playlists.length === 0) return null;
    return (
        <section>
            <div className="mb-3 flex items-center gap-2">
                <h2 className="text-lg font-semibold text-white">
                    From your peers
                </h2>
                <Network className="h-4 w-4 text-white/40" />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {playlists.slice(0, 10).map((playlist) => (
                    <Link
                        key={`${playlist.peer.id}:${playlist.remoteId}`}
                        href={`/peer-playlists/${encodeURIComponent(playlist.peer.id)}/${encodeURIComponent(playlist.remoteId)}`}
                        className="group rounded-lg border border-white/[0.06] bg-surface-hover p-3 transition-colors hover:bg-white/5"
                    >
                        <div className="mb-2 flex h-24 items-center justify-center rounded-md bg-white/5">
                            <ListMusic className="h-8 w-8 text-white/20 group-hover:text-white/40" />
                        </div>
                        <p className="truncate text-sm font-medium text-white">
                            {playlist.name}
                        </p>
                        <p className="truncate text-xs text-white/40">
                            {playlist.owner.displayName} · {playlist.trackCount}{" "}
                            tracks
                        </p>
                        <p className="mt-1 truncate text-[11px] text-white/30">
                            From {playlist.peer.name}
                        </p>
                    </Link>
                ))}
            </div>
        </section>
    );
}
