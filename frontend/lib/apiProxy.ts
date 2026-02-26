import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { normalizeApiBaseUrlInput } from "./api-base-url";
const getEnv = (): Record<string, string | undefined> => {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } })
        .process?.env ?? {};
};

const getBackendUrl = (): string => {
    const env = getEnv();
    return (
        normalizeApiBaseUrlInput(env?.BACKEND_URL) ??
        "http://127.0.0.1:3006"
    );
};

const getProxyTimeoutMs = (): number => {
    const env = getEnv();
    const parsed = Number(env?.PROXY_REQUEST_TIMEOUT_MS);
    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }
    return 20_000;
};

const isProxyDebugEnabled = (): boolean => {
    const env = getEnv();
    return env.NODE_ENV === "development" || env.PROXY_DEBUG_ERRORS === "true";
};

const LOG_SUPPRESSION_WINDOW_MS = 30_000;
const lastProxyLogByKey = new Map<string, number>();

const logProxyError = (
    key: string,
    summary: string,
    details?: unknown
): void => {
    if (isProxyDebugEnabled()) {
        if (details !== undefined) {
            sharedFrontendLogger.error(summary, details);
        } else {
            sharedFrontendLogger.error(summary);
        }
        return;
    }

    const now = Date.now();
    const previous = lastProxyLogByKey.get(key) ?? 0;
    if (now - previous < LOG_SUPPRESSION_WINDOW_MS) {
        return;
    }
    lastProxyLogByKey.set(key, now);
    sharedFrontendLogger.error(summary);
};

const extractNetworkCode = (error: unknown): string => {
    if (error && typeof error === "object") {
        const err = error as { code?: unknown; cause?: unknown };
        if (typeof err.code === "string") {
            return err.code;
        }
        if (err.cause && typeof err.cause === "object") {
            const cause = err.cause as { code?: unknown };
            if (typeof cause.code === "string") {
                return cause.code;
            }
        }
    }
    return "FETCH_FAILED";
};

const isExpectedStreamTermination = (error: unknown): boolean => {
    if (error instanceof DOMException && error.name === "AbortError") {
        return true;
    }

    const code = extractNetworkCode(error);
    if (code === "UND_ERR_SOCKET" || code === "ABORT_ERR") {
        return true;
    }

    const message = error instanceof Error ? error.message.toLowerCase() : "";
    return (
        message.includes("terminated") ||
        message.includes("socket") ||
        message.includes("aborted")
    );
};

const wrapUpstreamBody = (
    body: ReadableStream<Uint8Array> | null,
    method: string,
    targetPath: string
): ReadableStream<Uint8Array> | null => {
    if (!body) return null;

    const reader = body.getReader();
    let closed = false;

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (closed) return;
            try {
                const { done, value } = await reader.read();
                if (done) {
                    closed = true;
                    controller.close();
                    return;
                }
                if (value) {
                    controller.enqueue(value);
                }
            } catch (error) {
                closed = true;
                if (isExpectedStreamTermination(error)) {
                    const networkCode = extractNetworkCode(error);
                    logProxyError(
                        `stream-close:${method}:${targetPath}:${networkCode}`,
                        `[apiProxy] Upstream stream closed ${method} ${targetPath} (${networkCode})`
                    );
                    controller.close();
                    return;
                }
                controller.error(error);
            }
        },
        cancel(reason) {
            closed = true;
            void reader.cancel(reason).catch(() => {
                // Ignore cancellation errors; stream is already tearing down.
            });
        },
    });
};

const buildTargetUrl = (request: Request, targetPath: string): string => {
    const base = getBackendUrl();
    const normalizedPath = targetPath.replace(/^\/+/, "");
    const url = new URL(`${base}/${normalizedPath}`);
    url.search = new URL(request.url).search;
    return url.toString();
};

const buildProxyHeaders = (request: Request): Headers => {
    const headers = new Headers(request.headers);
    headers.delete("host");

    const host = request.headers.get("host");
    if (host) {
        headers.set("x-forwarded-host", host);
    }
    headers.set(
        "x-forwarded-proto",
        new URL(request.url).protocol.replace(":", "")
    );

    const forwardedFor = request.headers.get("x-forwarded-for");
    const realIp = request.headers.get("x-real-ip");
    if (!forwardedFor && realIp) {
        headers.set("x-forwarded-for", realIp);
    }

    return headers;
};

export const proxyRequest = async (
    request: Request,
    targetPath: string,
    methodOverride?: string
): Promise<Response> => {
    // Used by frontend same-origin API mode (`/app/api/[...path]` route handlers).
    const targetUrl = buildTargetUrl(request, targetPath);
    const headers = buildProxyHeaders(request);
    const method = methodOverride ?? request.method;

    const controller = new AbortController();
    const upstreamSignal = request.signal;
    const timeoutMs = getProxyTimeoutMs();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    const abortFromUpstream = () => {
        controller.abort(upstreamSignal.reason);
    };

    if (upstreamSignal.aborted) {
        abortFromUpstream();
    } else {
        upstreamSignal.addEventListener("abort", abortFromUpstream, {
            once: true,
        });
    }

    timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    const init: RequestInit = {
        method,
        headers,
        redirect: "manual",
        signal: controller.signal,
    };

    if (method !== "GET" && method !== "HEAD") {
        init.body = await request.arrayBuffer();
    }

    try {
        const upstream = await fetch(targetUrl, init);
        const responseHeaders = new Headers(upstream.headers);
        const responseBody = wrapUpstreamBody(upstream.body, method, targetPath);

        return new Response(responseBody, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: responseHeaders,
        });
    } catch (error) {
        if (timedOut) {
            logProxyError(
                `timeout:${method}:${targetPath}`,
                `[apiProxy] Upstream timeout (${timeoutMs}ms) ${method} ${targetPath}`
            );
            return Response.json(
                {
                    error: "Upstream request timed out",
                    code: "UPSTREAM_TIMEOUT",
                    description: "The frontend could not get a response from the backend in time.",
                },
                { status: 504 }
            );
        }

        const networkCode = extractNetworkCode(error);
        logProxyError(
            `network:${method}:${targetPath}:${networkCode}`,
            `[apiProxy] Upstream unavailable ${method} ${targetPath} (${networkCode})`,
            error
        );

        return Response.json(
            {
                error: "Backend service unavailable",
                code: "UPSTREAM_UNAVAILABLE",
                description: "The frontend could not reach the backend service.",
            },
            { status: 503 }
        );
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        upstreamSignal.removeEventListener("abort", abortFromUpstream);
    }
};
