"use client";

import { useEffect, useState } from "react";
import { Check, ExternalLink, Loader2, Search } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";

const MBID_UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface MusicBrainzArtist {
    mbid: string;
    name: string;
    disambiguation: string | null;
    country: string | null;
    type: string | null;
    score: number;
}

interface MusicBrainzReleaseGroup {
    rgMbid: string;
    title: string;
    primaryType: string;
    secondaryTypes: string[];
    firstReleaseDate: string | null;
    artistCredit: string;
    score: number;
}

interface MusicBrainzLookupProps {
    type: "artist" | "album";
    currentValue: string;
    currentName?: string;
    artistName?: string;
    onSelect: (mbid: string) => void;
}

export function MusicBrainzLookup({
    type,
    currentValue,
    currentName,
    artistName,
    onSelect,
}: MusicBrainzLookupProps) {
    const [searchQuery, setSearchQuery] = useState(currentName || "");
    const [isSearching, setIsSearching] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);
    const [artistResults, setArtistResults] = useState<MusicBrainzArtist[]>([]);
    const [albumResults, setAlbumResults] = useState<MusicBrainzReleaseGroup[]>(
        []
    );
    const [manualMbid, setManualMbid] = useState(currentValue || "");
    const [showManualInput, setShowManualInput] = useState(false);

    useEffect(() => {
        setManualMbid(currentValue || "");
    }, [currentValue]);

    useEffect(() => {
        setSearchQuery(currentName || "");
    }, [currentName]);

    const isTempMbid = currentValue?.startsWith("temp-");
    const hasValidMbid = Boolean(currentValue && !isTempMbid);

    const performSearch = async () => {
        if (searchQuery.trim().length < 2) return;

        setIsSearching(true);
        setHasSearched(true);

        try {
            if (type === "artist") {
                const response = await api.searchMusicBrainzArtists(searchQuery.trim());
                setArtistResults(response.artists);
                setAlbumResults([]);
                return;
            }

            const response = await api.searchMusicBrainzReleaseGroups(
                searchQuery.trim(),
                artistName
            );
            setAlbumResults(response.albums);
            setArtistResults([]);
        } catch (error: unknown) {
            console.error("MusicBrainz search error:", error);
            toast.error(
                error instanceof Error
                    ? error.message
                    : "MusicBrainz search failed"
            );
        } finally {
            setIsSearching(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
            e.preventDefault();
            void performSearch();
        }
    };

    const clearResults = () => {
        setArtistResults([]);
        setAlbumResults([]);
        setHasSearched(false);
    };

    const handleSelectArtist = (artist: MusicBrainzArtist) => {
        onSelect(artist.mbid);
        setManualMbid(artist.mbid);
        clearResults();
    };

    const handleSelectAlbum = (album: MusicBrainzReleaseGroup) => {
        onSelect(album.rgMbid);
        setManualMbid(album.rgMbid);
        clearResults();
    };

    const handleManualSubmit = () => {
        if (!MBID_UUID_REGEX.test(manualMbid.trim())) return;
        onSelect(manualMbid.trim());
        setShowManualInput(false);
        clearResults();
    };

    const getMusicBrainzUrl = () => {
        if (type === "artist") {
            return `https://musicbrainz.org/artist/${currentValue}`;
        }
        return `https://musicbrainz.org/release-group/${currentValue}`;
    };

    const hasResults = artistResults.length > 0 || albumResults.length > 0;

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-400">Current:</span>
                {isTempMbid ? (
                    <span className="rounded bg-yellow-500/10 px-2 py-0.5 font-mono text-xs text-yellow-500">
                        Temporary ID (needs matching)
                    </span>
                ) : hasValidMbid ? (
                    <span className="flex items-center gap-1 rounded bg-green-500/10 px-2 py-0.5 font-mono text-xs text-green-500">
                        <Check className="h-3 w-3" />
                        {currentValue.substring(0, 8)}...
                    </span>
                ) : (
                    <span className="text-xs text-gray-500">None</span>
                )}
                {hasValidMbid && (
                    <a
                        href={getMusicBrainzUrl()}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 transition-colors hover:text-blue-300"
                        title="View in MusicBrainz"
                    >
                        <ExternalLink className="h-4 w-4" />
                    </a>
                )}
            </div>

            <div className="space-y-2">
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={`Enter ${type} name to search...`}
                        className="flex-1 rounded border border-white/10 bg-[#181818] px-4 py-2 text-sm text-white focus:border-white/30 focus:outline-none"
                    />
                    <button
                        type="button"
                        onClick={() => void performSearch()}
                        disabled={isSearching || searchQuery.trim().length < 2}
                        className="flex items-center gap-2 rounded border border-white/10 bg-[#282828] px-4 py-2 text-sm text-white transition-colors hover:bg-[#333] disabled:bg-[#1a1a1a] disabled:text-gray-600"
                    >
                        {isSearching ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Search className="h-4 w-4" />
                        )}
                        Search
                    </button>
                </div>

                {hasSearched && (
                    <div className="max-h-64 overflow-y-auto rounded-lg border border-white/10 bg-[#1a1a1a]">
                        {hasResults ? (
                            type === "artist" ? (
                                artistResults.map((artist) => (
                                    <button
                                        key={artist.mbid}
                                        onClick={() => handleSelectArtist(artist)}
                                        className="w-full border-b border-white/5 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-white/5"
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate font-medium text-white">
                                                    {artist.name}
                                                </div>
                                                {artist.disambiguation && (
                                                    <div className="mt-0.5 truncate text-xs text-gray-400">
                                                        {artist.disambiguation}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex flex-shrink-0 items-center gap-2">
                                                {artist.country && (
                                                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-gray-500">
                                                        {artist.country}
                                                    </span>
                                                )}
                                                {artist.type && (
                                                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-gray-500">
                                                        {artist.type}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </button>
                                ))
                            ) : (
                                albumResults.map((album) => (
                                    <button
                                        key={album.rgMbid}
                                        onClick={() => handleSelectAlbum(album)}
                                        className="w-full border-b border-white/5 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-white/5"
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0 flex-1">
                                                <div className="truncate font-medium text-white">
                                                    {album.title}
                                                </div>
                                                <div className="mt-0.5 truncate text-xs text-gray-400">
                                                    {album.artistCredit}
                                                </div>
                                            </div>
                                            <div className="flex flex-shrink-0 items-center gap-2">
                                                {album.firstReleaseDate && (
                                                    <span className="text-xs text-gray-500">
                                                        {album.firstReleaseDate.substring(0, 4)}
                                                    </span>
                                                )}
                                                <span className="rounded bg-white/5 px-1.5 py-0.5 text-xs text-gray-500">
                                                    {album.primaryType}
                                                </span>
                                            </div>
                                        </div>
                                    </button>
                                ))
                            )
                        ) : (
                            <div className="p-4 text-center text-sm text-gray-400">
                                No results found. Try a different search or paste the MBID directly.
                            </div>
                        )}
                    </div>
                )}
            </div>

            <div>
                <button
                    type="button"
                    onClick={() => setShowManualInput(!showManualInput)}
                    className="text-xs text-gray-400 transition-colors hover:text-white"
                >
                    {showManualInput ? "Hide manual entry" : "Or paste MBID directly"}
                </button>

                {showManualInput && (
                    <div className="mt-2 flex gap-2">
                        <input
                            type="text"
                            value={manualMbid}
                            onChange={(e) => setManualMbid(e.target.value)}
                            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                            className="flex-1 rounded border border-white/10 bg-[#181818] px-4 py-2 font-mono text-xs text-white focus:border-white/30 focus:outline-none"
                        />
                        <button
                            type="button"
                            onClick={handleManualSubmit}
                            disabled={!MBID_UUID_REGEX.test(manualMbid.trim())}
                            className="flex items-center gap-1 rounded bg-[#3b82f6] px-3 py-2 text-sm font-medium text-black transition-colors hover:bg-[#2563eb] disabled:cursor-not-allowed disabled:bg-gray-600"
                        >
                            <Check className="h-4 w-4" />
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
