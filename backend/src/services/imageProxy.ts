import crypto from "crypto";
import { BRAND_USER_AGENT } from "../config/brand";

export const normalizeExternalImageUrl = (rawUrl: string): string | null => {
    try {
        const parsedUrl = new URL(rawUrl);
        const hostname = parsedUrl.hostname.toLowerCase();

        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            return null;
        }

        if (
            hostname === "localhost" ||
            hostname === "127.0.0.1" ||
            hostname === "::1" ||
            hostname === "0.0.0.0" ||
            hostname.startsWith("10.") ||
            hostname.startsWith("192.168.") ||
            hostname.startsWith("169.254.") ||
            hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) ||
            hostname.endsWith(".local") ||
            hostname.endsWith(".internal")
        ) {
            return null;
        }

        return parsedUrl.toString();
    } catch {
        return null;
    }
};

export type ExternalImageResult =
    | {
          ok: true;
          url: string;
          buffer: Buffer;
          contentType: string | null;
          etag: string;
      }
    | {
          ok: false;
          url: string;
          status: "invalid_url" | "not_found" | "fetch_error";
          message?: string;
      };

type ExternalImageFailure = Extract<ExternalImageResult, { ok: false }>;

async function fetchWithSafeRedirects(options: {
    url: string;
    timeoutMs: number;
    maxRedirects: number;
}): Promise<{ response: Response; finalUrl: string } | ExternalImageFailure> {
    const { url, timeoutMs, maxRedirects } = options;
    let currentUrl = url;

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
        const response = await fetch(currentUrl, {
            headers: {
                "User-Agent": BRAND_USER_AGENT,
            },
            signal: AbortSignal.timeout(timeoutMs),
            redirect: "manual",
        });

        const isRedirect = response.status >= 300 && response.status < 400;
        const location = response.headers.get("location");
        if (!isRedirect || !location) {
            return { response, finalUrl: currentUrl };
        }

        const redirectedUrl = new URL(location, currentUrl).toString();
        const normalizedRedirect = normalizeExternalImageUrl(redirectedUrl);
        if (!normalizedRedirect) {
            return {
                ok: false,
                url: redirectedUrl,
                status: "invalid_url",
                message: "Invalid redirect target",
            };
        }

        currentUrl = normalizedRedirect;
    }

    return {
        ok: false,
        url,
        status: "fetch_error",
        message: "Too many redirects",
    };
}

export async function fetchExternalImage(options: {
    url: string;
    timeoutMs?: number;
    maxRedirects?: number;
    maxRetries?: number;
}): Promise<ExternalImageResult> {
    const {
        url,
        timeoutMs = 15000,
        maxRedirects = 3,
        maxRetries = 3,
    } = options;
    const safeUrl = normalizeExternalImageUrl(url);

    if (!safeUrl) {
        return {
            ok: false,
            url,
            status: "invalid_url",
            message: "Invalid or private URL",
        };
    }

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
            const redirectResult = await fetchWithSafeRedirects({
                url: safeUrl,
                timeoutMs,
                maxRedirects,
            });

            if ("ok" in redirectResult) {
                return redirectResult;
            }

            const { response, finalUrl } = redirectResult;

            if (response.status === 404) {
                return {
                    ok: false,
                    url: finalUrl,
                    status: "not_found",
                };
            }

            if (!response.ok) {
                const message = `${response.status} ${response.statusText}`;
                if (response.status >= 500 && attempt < maxRetries) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 4000))
                    );
                    continue;
                }
                return {
                    ok: false,
                    url: finalUrl,
                    status: "fetch_error",
                    message,
                };
            }

            const buffer = Buffer.from(await response.arrayBuffer());
            const contentType = response.headers.get("content-type");
            const etag = crypto.createHash("md5").update(buffer).digest("hex");

            return {
                ok: true,
                url: finalUrl,
                buffer,
                contentType,
                etag,
            };
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                await new Promise((resolve) =>
                    setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 4000))
                );
                continue;
            }
        }
    }

    return {
        ok: false,
        url: safeUrl,
        status: "fetch_error",
        message:
            lastError instanceof Error ? lastError.message : "Unknown fetch error",
    };
}
