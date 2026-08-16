import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Histogram, type Registry } from "prom-client";

const DEFAULT_MAX_ROUTE_CLASSES = 100;
const HTTP_METHODS = new Set([
    "CONNECT",
    "DELETE",
    "GET",
    "HEAD",
    "OPTIONS",
    "PATCH",
    "POST",
    "PUT",
    "TRACE",
]);

type HttpLabels = {
    method: string;
    route_class: string;
    status_class: string;
};

/** Options controlling the bounded HTTP route vocabulary. */
export interface HttpRequestMetricsOptions {
    maxRouteClasses?: number;
}

/** Result of constructing isolated HTTP request instrumentation. */
export interface HttpRequestMetrics {
    histogram: Histogram<keyof HttpLabels>;
    middleware: RequestHandler;
}

function joinRoutePattern(baseUrl: string, routePath: string): string {
    if (!baseUrl) return routePath || "/";
    if (!routePath || routePath === "/") return baseUrl;
    if (baseUrl.endsWith("/") && routePath.startsWith("/")) {
        return baseUrl + routePath.slice(1);
    }
    if (!baseUrl.endsWith("/") && !routePath.startsWith("/")) {
        return `${baseUrl}/${routePath}`;
    }
    return baseUrl + routePath;
}

function requestRoutePattern(req: Request): string {
    const route = req.route as { path?: unknown } | undefined;
    if (typeof route?.path !== "string") return "unmatched";
    return joinRoutePattern(req.baseUrl, route.path);
}

function statusClass(statusCode: number): string {
    const value = Math.floor(statusCode / 100);
    return value >= 1 && value <= 5 ? `${value}xx` : "other";
}

function methodClass(method: string): string {
    return HTTP_METHODS.has(method) ? method : "OTHER";
}

function routeClassGuard(maxRouteClasses: number) {
    const knownRoutes = new Set<string>();
    return (candidate: string): string => {
        if (candidate === "unmatched" || knownRoutes.has(candidate)) {
            return candidate;
        }
        if (knownRoutes.size >= maxRouteClasses) return "other";
        knownRoutes.add(candidate);
        return candidate;
    };
}

/** Creates allocation-bounded Express request duration instrumentation. */
export function createHttpRequestMetrics(
    registry: Registry,
    options: HttpRequestMetricsOptions = {},
): HttpRequestMetrics {
    const maxRouteClasses = Math.max(
        1,
        Math.floor(options.maxRouteClasses ?? DEFAULT_MAX_ROUTE_CLASSES),
    );
    const boundRouteClass = routeClassGuard(maxRouteClasses);
    const labelCache = new Map<string, HttpLabels>();
    const histogram = new Histogram({
        name: "soundspan_http_request_duration_seconds",
        help: "Backend HTTP request duration in seconds.",
        labelNames: ["method", "route_class", "status_class"] as const,
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        registers: [registry],
    });

    const middleware = (
        req: Request,
        res: Response,
        next: NextFunction,
    ): void => {
        const startedAt = process.hrtime.bigint();
        res.once("finish", () => {
            const method = methodClass(req.method);
            const routeClass = boundRouteClass(requestRoutePattern(req));
            const responseClass = statusClass(res.statusCode);
            const cacheKey = `${method}\0${routeClass}\0${responseClass}`;
            let labels = labelCache.get(cacheKey);
            if (!labels) {
                labels = {
                    method,
                    route_class: routeClass,
                    status_class: responseClass,
                };
                labelCache.set(cacheKey, labels);
            }
            const durationSeconds =
                Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
            histogram.observe(labels, durationSeconds);
        });
        next();
    };

    return { histogram, middleware };
}
