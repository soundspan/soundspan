interface ReleaseGroupWithSecondaryTypes {
    "secondary-types"?: readonly string[];
}

const LIBRARY_DISCOGRAPHY_EXCLUDED_TYPES = new Set([
    "Live",
    "Compilation",
    "Soundtrack",
    "Remix",
    "DJ-mix",
    "Mixtape/Street",
    "Demo",
    "Interview",
    "Audio drama",
    "Audiobook",
    "Spokenword",
]);

/** Removes non-studio secondary release types from a library artist page. */
export function filterLibraryArtistReleaseGroups<
    T extends ReleaseGroupWithSecondaryTypes,
>(releaseGroups: readonly T[]): T[] {
    return releaseGroups.filter(
        (group) =>
            !group["secondary-types"]?.some((type) =>
                LIBRARY_DISCOGRAPHY_EXCLUDED_TYPES.has(type),
            ),
    );
}
