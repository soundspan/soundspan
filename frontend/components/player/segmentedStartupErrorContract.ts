interface LooseObject {
    [key: string]: unknown;
}

const RETRY_AFTER_HINT_MIN_MS = 1;
const RETRY_AFTER_HINT_MAX_MS = 30_000;

export interface SegmentedStartupErrorHint {
    isTransient: boolean | null;
    retryAfterMs: number | null;
    code: string | null;
    statusCode: number | null;
}

interface ResolveConservativeRetryDelayInput {
    computedDelayMs: number;
    retryAfterMsHint?: number | null;
    maxDelayMs?: number;
}

const asObject = (value: unknown): LooseObject | null => {
    if (!value || typeof value !== "object") {
        return null;
    }
    return value as LooseObject;
};

const parseHintBoolean = (value: unknown): boolean | null => {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
        return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
        return false;
    }
    return null;
};

const parsePositiveIntegerMs = (value: unknown): number | null => {
    let numericValue: number;
    if (typeof value === "number") {
        numericValue = value;
    } else if (typeof value === "string" && value.trim().length > 0) {
        numericValue = Number(value.trim());
    } else {
        return null;
    }

    if (!Number.isFinite(numericValue)) {
        return null;
    }
    const integerValue = Math.round(numericValue);
    if (integerValue < RETRY_AFTER_HINT_MIN_MS) {
        return null;
    }
    return integerValue;
};

const pickFirstBoolean = (
    record: LooseObject,
    keys: readonly string[],
): boolean | null => {
    for (const key of keys) {
        const parsed = parseHintBoolean(record[key]);
        if (parsed !== null) {
            return parsed;
        }
    }
    return null;
};

const pickFirstDelayMs = (
    record: LooseObject,
    keys: readonly string[],
): number | null => {
    for (const key of keys) {
        const parsed = parsePositiveIntegerMs(record[key]);
        if (parsed !== null) {
            return parsed;
        }
    }
    return null;
};

const collectHintRecords = (root: LooseObject): LooseObject[] => {
    const records: LooseObject[] = [root];
    const nestedCandidates: unknown[] = [
        root.segmentedStartupRetryHint,
        root.segmentedStartupHint,
        root.startupRetryHint,
        root.startupHint,
        root.retryHint,
        root.hint,
        root.details,
        root.hints,
    ];

    const hintsObject = asObject(root.hints);
    if (hintsObject) {
        nestedCandidates.push(
            hintsObject.segmentedStartupRetryHint,
            hintsObject.segmentedStartupHint,
            hintsObject.startupRetryHint,
            hintsObject.startupHint,
            hintsObject.retryHint,
            hintsObject.hint,
        );
    }

    const detailsObject = asObject(root.details);
    if (detailsObject) {
        nestedCandidates.push(
            detailsObject.segmentedStartupRetryHint,
            detailsObject.segmentedStartupHint,
            detailsObject.startupRetryHint,
            detailsObject.startupHint,
            detailsObject.retryHint,
            detailsObject.hint,
        );
    }

    for (const candidate of nestedCandidates) {
        const candidateRecord = asObject(candidate);
        if (!candidateRecord || records.includes(candidateRecord)) {
            continue;
        }
        records.push(candidateRecord);
    }

    return records;
};

export function parseSegmentedStartupErrorHint(
    error: unknown,
): SegmentedStartupErrorHint | null {
    const errorObject = asObject(error);
    const dataObject = asObject(errorObject?.data);
    const hintRecords = dataObject
        ? collectHintRecords(dataObject)
        : errorObject
          ? collectHintRecords(errorObject)
          : [];

    let isTransient: boolean | null = null;
    let retryAfterMs: number | null = null;
    for (const record of hintRecords) {
        if (isTransient === null) {
            isTransient = pickFirstBoolean(record, [
                "isTransient",
                "transient",
                "retryable",
                "shouldRetry",
            ]);
        }
        if (retryAfterMs === null) {
            retryAfterMs = pickFirstDelayMs(record, [
                "retryAfterMs",
                "retry_after_ms",
                "retryDelayMs",
                "retry_delay_ms",
            ]);
        }
        if (isTransient !== null && retryAfterMs !== null) {
            break;
        }
    }

    if (isTransient === null && retryAfterMs === null) {
        return null;
    }

    const code =
        typeof dataObject?.code === "string"
            ? dataObject.code
            : typeof errorObject?.code === "string"
              ? errorObject.code
              : null;
    const statusCodeRaw =
        typeof errorObject?.status === "number"
            ? errorObject.status
            : typeof dataObject?.statusCode === "number"
              ? dataObject.statusCode
              : null;
    const statusCode =
        typeof statusCodeRaw === "number" && Number.isFinite(statusCodeRaw)
            ? Math.round(statusCodeRaw)
            : null;

    return {
        isTransient,
        retryAfterMs,
        code,
        statusCode,
    };
}

export function resolveConservativeSegmentedStartupRetryDelayMs({
    computedDelayMs,
    retryAfterMsHint,
    maxDelayMs = RETRY_AFTER_HINT_MAX_MS,
}: ResolveConservativeRetryDelayInput): number {
    const normalizedComputedDelay = parsePositiveIntegerMs(computedDelayMs) ?? 0;
    const normalizedRetryHint = parsePositiveIntegerMs(retryAfterMsHint);
    if (normalizedRetryHint === null) {
        return normalizedComputedDelay;
    }

    const normalizedMaxDelay = Math.max(
        RETRY_AFTER_HINT_MIN_MS,
        parsePositiveIntegerMs(maxDelayMs) ?? RETRY_AFTER_HINT_MAX_MS,
    );
    const clampedHint = Math.min(normalizedRetryHint, normalizedMaxDelay);
    return Math.max(normalizedComputedDelay, clampedHint);
}
