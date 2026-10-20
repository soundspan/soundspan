/** Stable download failure categories used by Soulseek retry policy. */
export type DownloadErrorType =
    | "user_offline"
    | "timeout"
    | "connection"
    | "file_not_found"
    | "refused"
    | "unknown";

/** Download category and whether later attempts should skip the peer. */
export interface DownloadErrorInfo {
    type: DownloadErrorType;
    skipUser: boolean;
}

function normalizedErrorMessage(error: Error): string {
    return error.message.toLowerCase();
}

/** Categorize one download error without side effects. */
export function categorizeDownloadError(error: Error): DownloadErrorInfo {
    const message = normalizedErrorMessage(error);

    if (
        message.startsWith("cannot connect to ") ||
        message.startsWith("no address to reach ") ||
        message.startsWith("no connection to ") ||
        message.endsWith(" is not connected") ||
        message.includes("user not exist") ||
        message.includes("user offline")
    ) {
        return { type: "user_offline", skipUser: true };
    }
    if (
        message.startsWith("getpeeraddress timed out for ") ||
        message.startsWith("connecttopeer timed out for ")
    ) {
        return { type: "timeout", skipUser: true };
    }
    if (
        message.includes("file not shared") ||
        message.includes("file not found") ||
        message.includes("no such file")
    ) {
        return { type: "file_not_found", skipUser: true };
    }
    if (
        message.includes("transfer refused") ||
        message.includes("upload denied") ||
        message.includes("too many files") ||
        message.includes("banned")
    ) {
        return { type: "refused", skipUser: true };
    }
    if (message.startsWith("transfer interrupted at")) {
        return { type: "connection", skipUser: true };
    }
    if (
        message.includes("connection refused") ||
        message.includes("connection reset")
    ) {
        return { type: "connection", skipUser: true };
    }
    if (message.includes("timed out") || message.includes("timeout")) {
        return { type: "timeout", skipUser: true };
    }
    return { type: "unknown", skipUser: false };
}
