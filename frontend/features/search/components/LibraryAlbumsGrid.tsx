import Link from "next/link";
import { Disc3 } from "lucide-react";
import Image from "next/image";
import { api } from "@/lib/api";
import { Album } from "../types";
import { PeerBadge } from "@/components/ui/PeerBadge";

interface LibraryAlbumsGridProps {
    albums: Album[];
    limit?: number | null;
}

/**
 * Renders the LibraryAlbumsGrid component.
 */
export function LibraryAlbumsGrid({
    albums,
    limit = 6,
}: LibraryAlbumsGridProps) {
    const visibleAlbums =
        typeof limit === "number" ? albums.slice(0, limit) : albums;

    return (
        <div
            className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10 gap-4"
            data-tv-section="search-results-albums"
        >
            {visibleAlbums.map((album, index) => {
                const coverArtId = album.coverUrl || album.albumId;
                return (
                    <Link
                        key={album.id}
                        href={`/album/${album.id}`}
                        data-tv-card
                        data-tv-card-index={index}
                        tabIndex={0}
                    >
                        <div className="bg-surface-sunken hover:bg-surface-elevated transition-all p-4 rounded-lg group cursor-pointer">
                            <div className="relative aspect-square bg-surface-elevated rounded-md mb-4 flex items-center justify-center overflow-hidden">
                                {coverArtId ? (
                                    <Image
                                        src={api.getCoverArtUrl(
                                            coverArtId,
                                            200,
                                        )}
                                        alt={album.title}
                                        fill
                                        className="object-cover"
                                        loading="lazy"
                                        unoptimized
                                    />
                                ) : (
                                    <Disc3 className="w-12 h-12 text-gray-400" />
                                )}
                            </div>
                            <h3 className="text-base font-bold text-white line-clamp-1 mb-1">
                                {album.title}
                            </h3>
                            <div className="flex items-center gap-2">
                                <p className="min-w-0 flex-1 text-sm text-gray-400 line-clamp-1">
                                    {album.artist?.name}
                                </p>
                                {album.source === "federated" && album.peer && (
                                    <PeerBadge
                                        peerName={album.peer.name}
                                        online={album.peer.online}
                                    />
                                )}
                            </div>
                        </div>
                    </Link>
                );
            })}
        </div>
    );
}
