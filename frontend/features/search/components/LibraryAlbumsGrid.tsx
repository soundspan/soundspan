import Link from "next/link";
import { Disc3 } from "lucide-react";
import Image from "next/image";
import { api } from "@/lib/api";
import { Album } from "../types";

interface LibraryAlbumsGridProps {
    albums: Album[];
    limit?: number | null;
}

export function LibraryAlbumsGrid({ albums, limit = 6 }: LibraryAlbumsGridProps) {
    const visibleAlbums =
        typeof limit === "number" ? albums.slice(0, limit) : albums;

    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10 gap-4" data-tv-section="search-results-albums">
            {visibleAlbums.map((album, index) => (
                <Link
                    key={album.id}
                    href={`/album/${album.id}`}
                    data-tv-card
                    data-tv-card-index={index}
                    tabIndex={0}
                >
                    <div className="bg-[#121212] hover:bg-[#181818] transition-all p-4 rounded-lg group cursor-pointer">
                        <div className="relative aspect-square bg-[#181818] rounded-md mb-4 flex items-center justify-center overflow-hidden">
                            {album.coverUrl || album.albumId ? (
                                <Image
                                    src={api.getCoverArtUrl(
                                        album.coverUrl || album.albumId,
                                        200
                                    )}
                                    alt={album.title}
                                    fill
                                    className="object-cover"
                                    loading="lazy"
                                    unoptimized
                                />
                            ) : (
                                <Disc3 className="w-12 h-12 text-gray-600" />
                            )}
                        </div>
                        <h3 className="text-base font-bold text-white line-clamp-1 mb-1">
                            {album.title}
                        </h3>
                        <p className="text-sm text-[#b3b3b3] line-clamp-1">
                            {album.artist?.name}
                        </p>
                    </div>
                </Link>
            ))}
        </div>
    );
}
