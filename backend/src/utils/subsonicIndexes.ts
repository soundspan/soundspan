import { toSubsonicId } from "./subsonicIds";

export interface ArtistIndexEntryInput {
    id: string;
    name: string;
    albumCount: number;
    coverArtId?: string;
}

export interface SubsonicIndexedArtist {
    id: string;
    name: string;
    albumCount: number;
    coverArt?: string;
}

export interface SubsonicArtistIndexGroup {
    name: string;
    artist: SubsonicIndexedArtist[];
}

function normalizeIndexLetter(name: string): string {
    const firstChar = name.trim().charAt(0).toUpperCase();
    return /^[A-Z]$/.test(firstChar) ? firstChar : "#";
}

export function buildArtistIndexes(
    artists: ArtistIndexEntryInput[],
    options?: { lastModified?: number },
): {
    lastModified: number;
    ignoredArticles: string;
    index: SubsonicArtistIndexGroup[];
} {
    const grouped = new Map<string, SubsonicIndexedArtist[]>();

    for (const artist of artists) {
        const bucket = normalizeIndexLetter(artist.name);
        if (!grouped.has(bucket)) {
            grouped.set(bucket, []);
        }

        grouped.get(bucket)!.push({
            id: toSubsonicId("artist", artist.id),
            name: artist.name,
            albumCount: artist.albumCount,
            coverArt: artist.coverArtId,
        });
    }

    const index = Array.from(grouped.entries())
        .sort(([left], [right]) => {
            if (left === "#") return 1;
            if (right === "#") return -1;
            return left.localeCompare(right);
        })
        .map(([name, bucketArtists]) => ({
            name,
            artist: bucketArtists.sort((left, right) =>
                left.name.localeCompare(right.name),
            ),
        }));

    return {
        lastModified: options?.lastModified ?? Date.now(),
        ignoredArticles: "The El La Los Las Le Les",
        index,
    };
}
