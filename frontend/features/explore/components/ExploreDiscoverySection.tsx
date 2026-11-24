"use client";

import Link from "next/link";
import Image from "next/image";
import { memo, useState } from "react";
import { Disc3, Music } from "lucide-react";
import {
    api,
    type ExploreDiscovery,
    type ExploreDiscoveryArtist,
} from "@/lib/api";
import { SectionHeader } from "@/components/layout/SectionHeader";
import {
    HorizontalCarousel,
    CarouselItem,
} from "@/components/ui/HorizontalCarousel";
import { LastFmBadge } from "@/components/ui/LastFmBadge";
import { getArtistRouteParam } from "@/utils/artistRoute";
import { DiscoverTracksList } from "@/features/search/components/DiscoverTracksList";

const TRENDING_TRACK_LIMIT = 10;

function titleCaseTag(tag: string): string {
    return tag.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function artistHref(artist: { name: string; mbid?: string }): string {
    const routeParam =
        getArtistRouteParam(
            { mbid: artist.mbid, name: artist.name },
            { preferLibraryId: false },
        ) || encodeURIComponent(artist.name);
    return `/artist/${routeParam}`;
}

function formatReleaseDate(date: string): string {
    const parsed = new Date(
        `${date.length === 4 ? `${date}-01-01` : date}T00:00:00Z`,
    );
    if (Number.isNaN(parsed.getTime())) return date;
    return parsed.toLocaleDateString(undefined, {
        month: "short",
        day: date.length >= 10 ? "numeric" : undefined,
        year: "numeric",
        timeZone: "UTC",
    });
}

const DiscoveryArtistCard = memo(function DiscoveryArtistCard({
    artist,
    index,
}: {
    artist: ExploreDiscoveryArtist;
    index: number;
}) {
    const imageUrl = artist.image
        ? api.getCoverArtUrl(artist.image, 300)
        : null;
    return (
        <CarouselItem>
            <Link
                href={artistHref(artist)}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                <div className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors">
                    <div className="aspect-square bg-surface-highlight rounded-full mb-3 flex items-center justify-center overflow-hidden relative shadow-lg">
                        {imageUrl ? (
                            <Image
                                src={imageUrl}
                                alt={artist.name}
                                fill
                                sizes="180px"
                                className="object-cover group-hover:scale-105 transition-transform duration-300"
                                unoptimized
                            />
                        ) : (
                            <Music className="w-10 h-10 text-gray-400" />
                        )}
                    </div>
                    <h3 className="text-sm font-semibold text-white truncate">
                        {artist.name}
                    </h3>
                    {artist.because && (
                        <p className="text-xs text-gray-400 mt-0.5 truncate">
                            Because you like {artist.because}
                        </p>
                    )}
                </div>
            </Link>
        </CarouselItem>
    );
});

function DiscoveryArtistsCarousel({
    artists,
}: {
    artists: ExploreDiscoveryArtist[];
}) {
    return (
        <HorizontalCarousel>
            {artists.map((artist, index) => (
                <DiscoveryArtistCard
                    key={artist.mbid || artist.name}
                    artist={artist}
                    index={index}
                />
            ))}
        </HorizontalCarousel>
    );
}

const ReleaseCard = memo(function ReleaseCard({
    release,
    index,
}: {
    release: ExploreDiscovery["newReleases"][number];
    index: number;
}) {
    const [coverFailed, setCoverFailed] = useState(false);
    const coverUrl = coverFailed
        ? null
        : api.getCoverArtUrl(release.coverUrl, 300);
    const subtitle = [
        release.artistName,
        formatReleaseDate(release.releaseDate),
    ]
        .filter(Boolean)
        .join(" • ");
    return (
        <CarouselItem>
            <Link
                href={`/album/${release.rgMbid}`}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                <div className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors">
                    <div className="aspect-square bg-surface-highlight rounded-md mb-3 flex items-center justify-center overflow-hidden relative shadow-lg">
                        {coverUrl ? (
                            <Image
                                src={coverUrl}
                                alt={release.title}
                                fill
                                sizes="180px"
                                className="object-cover group-hover:scale-105 transition-transform duration-300"
                                unoptimized
                                onError={() => setCoverFailed(true)}
                            />
                        ) : (
                            <Disc3 className="w-10 h-10 text-gray-400" />
                        )}
                    </div>
                    <h3 className="text-sm font-semibold text-white truncate">
                        {release.title}
                    </h3>
                    <p className="text-xs text-gray-400 mt-0.5 truncate">
                        {subtitle}
                    </p>
                </div>
            </Link>
        </CarouselItem>
    );
});

/**
 * Explore shelves of music that is not in the library: similar artists,
 * new releases, trending tracks, and genre/tag tops. Artists open the
 * artist page, releases open the album page (MusicBrainz fallback), and
 * tracks stream through the existing TIDAL/YouTube Music matching.
 */
export function ExploreDiscoverySection({
    discovery,
}: {
    discovery: ExploreDiscovery;
}) {
    const {
        personalized,
        similarArtists,
        newReleases,
        trendingTracks,
        tagShelves,
    } = discovery;

    return (
        <>
            {similarArtists.length > 0 && (
                <section>
                    <SectionHeader
                        title="Artists You Might Like"
                        description="Not in your library yet, based on what you play and like"
                        badge={<LastFmBadge />}
                    />
                    <DiscoveryArtistsCarousel artists={similarArtists} />
                </section>
            )}

            {newReleases.length > 0 && (
                <section>
                    <SectionHeader
                        title="New Releases For You"
                        description="Recent releases from artists you listen to"
                        badge="MusicBrainz"
                    />
                    <HorizontalCarousel>
                        {newReleases.map((release, index) => (
                            <ReleaseCard
                                key={release.rgMbid}
                                release={release}
                                index={index}
                            />
                        ))}
                    </HorizontalCarousel>
                </section>
            )}

            {trendingTracks.length > 0 && (
                <section>
                    <SectionHeader
                        title="Trending Now"
                        description="Popular right now and not in your library"
                        badge={<LastFmBadge />}
                    />
                    <DiscoverTracksList
                        tracks={trendingTracks}
                        limit={TRENDING_TRACK_LIMIT}
                    />
                </section>
            )}

            {tagShelves.map((shelf) => (
                <section key={shelf.tag}>
                    <SectionHeader
                        title={`${personalized ? "More" : "Popular in"} ${titleCaseTag(shelf.tag)}`}
                        badge={<LastFmBadge />}
                    />
                    <DiscoveryArtistsCarousel artists={shelf.artists} />
                </section>
            ))}
        </>
    );
}
