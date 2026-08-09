/**
 * Format seconds into a human-readable time string
 * For durations under 1 hour: m:ss (e.g., 5:32)
 * For durations 1 hour or more: h:mm:ss (e.g., 1:05:32)
 */
export function formatTime(seconds: number): string {
    if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return "0:00";

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours}:${mins.toString().padStart(2, "0")}:${secs
            .toString()
            .padStart(2, "0")}`;
    }
    return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Format seconds into a human-readable duration string
 * Always shows full format for clarity (e.g., "2h 30m" or "45m")
 */
export function formatDuration(seconds: number): string {
    if (isNaN(seconds) || !isFinite(seconds) || seconds < 0) return "0m";

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
        if (mins > 0) {
            return `${hours}h ${mins}m`;
        }
        return `${hours}h`;
    }
    return `${mins}m`;
}

/** Custom labels used when formatting compact relative times. */
export interface RelativeTimeOptions {
    justNowLabel?: string;
    suffix?: string;
}

/**
 * Format a date as a compact relative time or a locale date when older than a day.
 */
export function formatRelativeTime(
    dateInput: string | number | Date,
    options?: RelativeTimeOptions
): string {
    const justNowLabel = options?.justNowLabel ?? "Just now";
    const suffix = options?.suffix ?? " ago";
    const date = new Date(dateInput);
    const diff = Date.now() - date.getTime();

    if (diff < 60000) return justNowLabel;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m${suffix}`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h${suffix}`;
    return date.toLocaleDateString();
}

/**
 * Clamp a time value to be within valid bounds
 * Ensures currentTime never exceeds duration
 */
export function clampTime(currentTime: number, duration: number): number {
    if (duration <= 0) return Math.max(0, currentTime);
    return Math.min(Math.max(0, currentTime), duration);
}

/**
 * Format remaining time with negative prefix
 * For durations under 1 hour: -m:ss (e.g., -5:32)
 * For durations 1 hour or more: -h:mm:ss (e.g., -1:05:32)
 */
export function formatTimeRemaining(seconds: number): string {
    if (isNaN(seconds) || !isFinite(seconds) || seconds <= 0) return "0:00";

    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `-${hours}:${mins.toString().padStart(2, "0")}:${secs
            .toString()
            .padStart(2, "0")}`;
    }
    return `-${mins}:${secs.toString().padStart(2, "0")}`;
}
