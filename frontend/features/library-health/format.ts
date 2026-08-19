/** Pure display formatters for the Library Insights dashboard. */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Formats a byte count as a compact human-readable size. */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    const digits = value >= 100 || unit === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

/** Formats a derived bitrate in kbps, or an em dash when unknown. */
export function formatKbps(kbps: number | null): string {
    if (kbps === null || !Number.isFinite(kbps) || kbps < 0) return "—";
    return `${Math.round(kbps)} kbps`;
}

/** Formats a completed/total pair as a whole-number percentage string. */
export function formatCoveragePercent(done: number, total: number): string {
    if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) {
        return "—";
    }
    const clamped = Math.min(Math.max(done, 0), total);
    return `${Math.round((clamped / total) * 100)}%`;
}
