export interface GenreCount {
    genre: string;
    count: number;
}

/**
 * Selects the featured genres shown in library radio cards.
 */
export const selectFeaturedRadioGenres = (
    genres: GenreCount[],
    maxGenres = 6,
    minTracks = 15
): GenreCount[] => {
    const eligibleGenres = genres.filter((genre) => genre.count >= minTracks);
    const featuredGenres = eligibleGenres.slice(0, maxGenres);
    const soundtrackGenre = eligibleGenres.find((genre) =>
        genre.genre.toLowerCase().includes("soundtrack")
    );

    if (!soundtrackGenre) {
        return featuredGenres;
    }

    if (
        featuredGenres.some(
            (genre) => genre.genre.toLowerCase() === soundtrackGenre.genre.toLowerCase()
        )
    ) {
        return featuredGenres;
    }

    if (featuredGenres.length < maxGenres) {
        return [...featuredGenres, soundtrackGenre];
    }

    return [...featuredGenres.slice(0, maxGenres - 1), soundtrackGenre];
};
