type ErrorRecord = Record<string, unknown>;

function asRecord(value: unknown): ErrorRecord | null {
    return typeof value === "object" && value !== null
        ? (value as ErrorRecord)
        : null;
}

function stringNames(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (!Array.isArray(value)) return [];
    return value
        .slice(0, 10)
        .filter((item): item is string => typeof item === "string");
}

function constraintNames(value: unknown): string[] {
    const constraint = asRecord(value);
    return [
        ...stringNames(value),
        ...stringNames(constraint?.fields),
        ...stringNames(constraint?.index),
    ];
}

function foreignKeyNames(meta: ErrorRecord): string[] {
    const driverAdapterError = asRecord(meta.driverAdapterError);
    const cause = asRecord(driverAdapterError?.cause);
    // The adapter nests the constraint under driverAdapterError.cause; the classic engine used flat keys.
    return [
        ...constraintNames(meta.constraint),
        ...constraintNames(cause?.constraint),
        ...stringNames(meta.field_name),
        ...stringNames(meta.fieldName),
        ...stringNames(meta.target),
    ];
}

/** Return whether an unknown value carries the requested Prisma error code. */
export function hasErrorCode(error: unknown, code: string): boolean {
    const record = asRecord(error);
    return record?.code === code;
}

/** Return whether a P2003 identifies the requested foreign-key constraint. */
export function isForeignKeyViolationOn(
    error: unknown,
    constraint: string,
): boolean {
    if (!hasErrorCode(error, "P2003")) return false;
    const meta = asRecord(asRecord(error)?.meta);
    const names = meta ? foreignKeyNames(meta) : [];
    if (names.length === 0) return false;
    return names.some(
        (name) =>
            name === constraint ||
            name.includes(constraint) ||
            constraint.includes(name),
    );
}
