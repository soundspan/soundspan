export interface M3UEntry {
    filePath: string;
    artist: string | null;
    title: string | null;
    durationSeconds: number | null;
}

export interface ParseM3UOptions {
    maxEntries?: number;
}

type PendingMetadata = {
    artist: string | null;
    title: string | null;
    durationSeconds: number | null;
};

const DEFAULT_MAX_ENTRIES = 10000;

function parseExtinf(payload: string): PendingMetadata {
    const commaIndex = payload.indexOf(",");
    const durationPart =
        commaIndex >= 0 ? payload.slice(0, commaIndex).trim() : payload.trim();
    const titlePart = commaIndex >= 0 ? payload.slice(commaIndex + 1).trim() : "";
    const metadata: PendingMetadata = {
        artist: null,
        title: null,
        durationSeconds: null,
    };

    if (/^-?\d+$/.test(durationPart)) {
        metadata.durationSeconds = Number.parseInt(durationPart, 10);
    }

    if (titlePart.length > 0) {
        const separatorIndex = titlePart.indexOf(" - ");
        if (separatorIndex > 0) {
            metadata.artist = titlePart.slice(0, separatorIndex).trim() || null;
            metadata.title =
                titlePart.slice(separatorIndex + 3).trim() || null;
        } else {
            metadata.title = titlePart;
        }
    }

    return metadata;
}

/**
 * Parse plain and extended M3U/M3U8 content into normalized playlist entries.
 */
export function parseM3U(
    content: string,
    options: ParseM3UOptions = {}
): M3UEntry[] {
    if (content.includes("\0")) {
        throw new Error("M3U content contains null bytes");
    }

    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
        throw new Error("maxEntries must be a positive integer");
    }

    const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
    const entries: M3UEntry[] = [];
    let pendingMetadata: PendingMetadata | null = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length === 0) {
            continue;
        }

        if (line.startsWith("#")) {
            if (line.toUpperCase().startsWith("#EXTINF:")) {
                pendingMetadata = parseExtinf(line.slice(8));
            }
            continue;
        }

        const entry: M3UEntry = {
            filePath: line.replace(/\\/g, "/"),
            artist: pendingMetadata?.artist ?? null,
            title: pendingMetadata?.title ?? null,
            durationSeconds: pendingMetadata?.durationSeconds ?? null,
        };
        pendingMetadata = null;

        entries.push(entry);
        if (entries.length > maxEntries) {
            throw new Error(`M3U file exceeds maximum of ${maxEntries} entries`);
        }
    }

    return entries;
}
