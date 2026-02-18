"use client";

import { useState, useEffect, useRef } from "react";
import { Album, ArtistSource } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { PlayableCard } from "@/components/ui/PlayableCard";
import { Disc3 } from "lucide-react";
import { api } from "@/lib/api";

interface AvailableAlbumsProps {
    albums: Album[];
    artistName: string;
    source: ArtistSource;
    colors: ColorPalette | null;
    onDownloadAlbum: (album: Album, e: React.MouseEvent) => void;
    onSearchAlbum?: (album: Album, e: React.MouseEvent) => void;
    isPendingDownload: (mbid: string) => boolean;
    downloadsEnabled?: boolean;
}

const COVER_PREFETCH_ROOT_MARGIN = "320px 0px";

function resolveAlbumCoverUrl(album: Album, source: ArtistSource): string | null {
    if (source === "library" && album.coverArt) {
        return api.getCoverArtUrl(album.coverArt, 300);
    }
    if (album.coverUrl) {
        return api.getCoverArtUrl(album.coverUrl, 300);
    }
    return null;
}

// Component to handle lazy-loading cover art for albums without cached covers
function LazyAlbumCard({
    album,
    source,
    colors,
    onDownloadAlbum,
    onSearchAlbum,
    isPendingDownload,
    index,
    downloadsEnabled = true,
}: {
    album: Album;
    source: ArtistSource;
    colors: ColorPalette | null;
    onDownloadAlbum: (album: Album, e: React.MouseEvent) => void;
    onSearchAlbum?: (album: Album, e: React.MouseEvent) => void;
    isPendingDownload: (mbid: string) => boolean;
    index: number;
    downloadsEnabled?: boolean;
}) {
    const [coverArt, setCoverArt] = useState<string | null>(() =>
        resolveAlbumCoverUrl(album, source)
    );
    const [fetchAttempted, setFetchAttempted] = useState(false);
    const [isNearViewport, setIsNearViewport] = useState(false);
    const cardRef = useRef<HTMLDivElement | null>(null);
    const propCoverUrl = resolveAlbumCoverUrl(album, source);

    const mbid = album.rgMbid || album.mbid;
    const shouldFetchMissingCover =
        !coverArt &&
        !fetchAttempted &&
        Boolean(mbid && !mbid.startsWith("temp-"));

    useEffect(() => {
        if (propCoverUrl) {
            setCoverArt(propCoverUrl);
            setFetchAttempted(true);
            setIsNearViewport(false);
        }
    }, [propCoverUrl]);

    useEffect(() => {
        if (!shouldFetchMissingCover) return;

        if (typeof IntersectionObserver === "undefined") {
            setIsNearViewport(true);
            return;
        }

        const target = cardRef.current;
        if (!target) return;

        const observer = new IntersectionObserver(
            (entries, currentObserver) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setIsNearViewport(true);
                    currentObserver.disconnect();
                }
            },
            {
                rootMargin: COVER_PREFETCH_ROOT_MARGIN,
                threshold: 0.01,
            }
        );

        observer.observe(target);
        return () => observer.disconnect();
    }, [shouldFetchMissingCover]);

    useEffect(() => {
        if (!shouldFetchMissingCover || !isNearViewport || !mbid) return;

        let cancelled = false;
        const fetchCover = async () => {
            try {
                const response = await api.request<{ coverUrl: string }>(
                    `/library/album-cover/${mbid}`
                );
                if (!cancelled && response.coverUrl) {
                    setCoverArt(api.getCoverArtUrl(response.coverUrl, 300));
                }
            } catch {
                // Cover not found, leave as null
            } finally {
                if (!cancelled) {
                    setFetchAttempted(true);
                }
            }
        };

        fetchCover();
        return () => {
            cancelled = true;
        };
    }, [isNearViewport, mbid, shouldFetchMissingCover]);

    const albumMbid = album.rgMbid || album.mbid || "";

    // Build subtitle with year and type
    const subtitleParts: string[] = [];
    if (album.year) subtitleParts.push(String(album.year));
    if (album.type) subtitleParts.push(album.type);
    const subtitle = subtitleParts.join(" • ");

    return (
        <div ref={cardRef}>
            <PlayableCard
                key={album.id}
                href={`/album/${album.id}`}
                coverArt={coverArt}
                title={album.title}
                subtitle={subtitle}
                placeholderIcon={
                    <Disc3 className="w-12 h-12 text-gray-600" />
                }
                circular={false}
                badge={downloadsEnabled ? "download" : null}
                showPlayButton={false}
                colors={colors}
                isDownloading={isPendingDownload(albumMbid)}
                onDownload={(e) => onDownloadAlbum(album, e)}
                onSearch={
                    onSearchAlbum ?
                        (e) => onSearchAlbum(album, e)
                    :   undefined
                }
                tvCardIndex={index}
            />
        </div>
    );
}

function AlbumGrid({
    albums,
    source,
    colors,
    onDownloadAlbum,
    onSearchAlbum,
    isPendingDownload,
    downloadsEnabled,
}: Omit<AvailableAlbumsProps, "artistName">) {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {albums.map((album, index) => (
                <LazyAlbumCard
                    key={album.id}
                    album={album}
                    source={source}
                    colors={colors}
                    onDownloadAlbum={onDownloadAlbum}
                    onSearchAlbum={onSearchAlbum}
                    isPendingDownload={isPendingDownload}
                    index={index}
                    downloadsEnabled={downloadsEnabled}
                />
            ))}
        </div>
    );
}

export function AvailableAlbums({
    albums,
    artistName: _artistName,
    source,
    colors,
    onDownloadAlbum,
    onSearchAlbum,
    isPendingDownload,
    downloadsEnabled = true,
}: AvailableAlbumsProps) {
    if (!albums || albums.length === 0) {
        return null;
    }

    // Separate studio albums from EPs/Singles/Demos
    const studioAlbums = albums.filter(
        (album) => album.type?.toLowerCase() === "album"
    );
    const epsAndSingles = albums.filter(
        (album) => album.type?.toLowerCase() !== "album"
    );

    return (
        <>
            {/* Studio Albums Section */}
            {studioAlbums.length > 0 && (
                <section>
                    <h2 className="text-xl font-bold mb-4">
                        Albums Available
                    </h2>
                    <div data-tv-section="available-albums">
                        <AlbumGrid
                            albums={studioAlbums}
                            source={source}
                            colors={colors}
                            onDownloadAlbum={onDownloadAlbum}
                            onSearchAlbum={onSearchAlbum}
                            isPendingDownload={isPendingDownload}
                            downloadsEnabled={downloadsEnabled}
                        />
                    </div>
                </section>
            )}

            {/* EPs, Singles & Demos Section */}
            {epsAndSingles.length > 0 && (
                <section>
                    <h2 className="text-xl font-bold mb-4">
                        Singles and EPs
                    </h2>
                    <div data-tv-section="available-eps-singles">
                        <AlbumGrid
                            albums={epsAndSingles}
                            source={source}
                            colors={colors}
                            onDownloadAlbum={onDownloadAlbum}
                            onSearchAlbum={onSearchAlbum}
                            isPendingDownload={isPendingDownload}
                            downloadsEnabled={downloadsEnabled}
                        />
                    </div>
                </section>
            )}
        </>
    );
}
