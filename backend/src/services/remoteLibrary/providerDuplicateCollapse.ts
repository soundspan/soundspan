import type { RemoteLibraryProvider, RemoteLibraryMapping } from "./types";

/** Minimum provider-row shape required for canonical duplicate collapse. */
export interface ProviderMappedRow {
    mappings?: ReadonlyArray<RemoteLibraryMapping>;
}

function canonicalMappingKeys(row: ProviderMappedRow): string[] {
    return (row.mappings ?? []).flatMap((mapping) => [
        `mapping:${mapping.id}`,
        ...(mapping.trackId ? [`track:${mapping.trackId}`] : []),
    ]);
}

function collectMappingKeys(
    rows: ReadonlyArray<ProviderMappedRow>,
): Set<string> {
    return new Set(rows.flatMap(canonicalMappingKeys));
}

function excludesPreferredDuplicates<T extends ProviderMappedRow>(
    rows: ReadonlyArray<T>,
    preferredKeys: ReadonlySet<string>,
): T[] {
    return rows.filter((row) =>
        canonicalMappingKeys(row).every((key) => !preferredKeys.has(key)),
    );
}

/** Collapses only cross-provider rows proven equivalent by active mappings. */
export function collapseProviderDuplicates<
    Tidal extends ProviderMappedRow,
    Youtube extends ProviderMappedRow,
>(
    tidalRows: ReadonlyArray<Tidal>,
    youtubeRows: ReadonlyArray<Youtube>,
    preferredProvider: RemoteLibraryProvider,
): Array<Tidal | Youtube> {
    const sets = collapseProviderDuplicateSets(
        tidalRows,
        youtubeRows,
        preferredProvider,
    );
    return [...sets.tidalRows, ...sets.youtubeRows];
}

/** Returns provider-specific lists after cross-provider duplicate collapse. */
export function collapseProviderDuplicateSets<
    Tidal extends ProviderMappedRow,
    Youtube extends ProviderMappedRow,
>(
    tidalRows: ReadonlyArray<Tidal>,
    youtubeRows: ReadonlyArray<Youtube>,
    preferredProvider: RemoteLibraryProvider,
): { tidalRows: Tidal[]; youtubeRows: Youtube[] } {
    if (preferredProvider === "tidal") {
        return {
            tidalRows: [...tidalRows],
            youtubeRows: excludesPreferredDuplicates(
                youtubeRows,
                collectMappingKeys(tidalRows),
            ),
        };
    }
    return {
        tidalRows: excludesPreferredDuplicates(
            tidalRows,
            collectMappingKeys(youtubeRows),
        ),
        youtubeRows: [...youtubeRows],
    };
}
