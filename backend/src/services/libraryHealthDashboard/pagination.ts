/** Offset pagination accepted by Library Health read models. */
export interface LibraryHealthPagination {
    limit: number;
    offset: number;
}

/** Clamps service-level pagination so non-HTTP callers remain bounded. */
export function normalizePagination(
    pagination: LibraryHealthPagination,
    maximumLimit = 100,
): LibraryHealthPagination {
    const limit = Number.isSafeInteger(pagination.limit)
        ? Math.min(maximumLimit, Math.max(1, pagination.limit))
        : Math.min(50, maximumLimit);
    const offset = Number.isSafeInteger(pagination.offset)
        ? Math.max(0, pagination.offset)
        : 0;
    return { limit, offset };
}
