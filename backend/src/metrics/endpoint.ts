import { createHash, timingSafeEqual } from "node:crypto";
import {
    Router,
    type NextFunction,
    type Request,
    type Response,
} from "express";
import type { Registry } from "prom-client";

/** Configuration for the Prometheus scrape route. */
export interface MetricsEndpointOptions {
    registry: Registry;
    token?: string;
    publicAccess: boolean;
}

function valuesMatch(provided: string, expected: string): boolean {
    const providedHash = createHash("sha256").update(provided).digest();
    const expectedHash = createHash("sha256").update(expected).digest();
    return timingSafeEqual(providedHash, expectedHash);
}

/** Checks a bearer header without exposing token length through comparison time. */
export function isMetricsRequestAuthorized(
    authorization: string | undefined,
    options: Pick<MetricsEndpointOptions, "token" | "publicAccess">,
): boolean {
    if (options.publicAccess) return true;
    if (!options.token || !authorization?.startsWith("Bearer ")) return false;
    const provided = authorization.slice("Bearer ".length);
    return provided.length > 0 && valuesMatch(provided, options.token);
}

function requireMetricsAccess(options: MetricsEndpointOptions) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (isMetricsRequestAuthorized(req.get("authorization"), options)) {
            next();
            return;
        }
        res.set("WWW-Authenticate", 'Bearer realm="metrics"');
        res.status(401).json({ error: "Unauthorized" });
    };
}

function createMetricsHandler(registry: Registry) {
    return async (
        _req: Request,
        res: Response,
        next: NextFunction,
    ): Promise<void> => {
        try {
            res.set("Content-Type", registry.contentType);
            res.send(await registry.metrics());
        } catch (error) {
            next(error);
        }
    };
}

/** Creates the isolated `/metrics` router with fail-closed bearer auth. */
export function createMetricsRouter(options: MetricsEndpointOptions): Router {
    const router = Router();
    router.get(
        "/metrics",
        requireMetricsAccess(options),
        createMetricsHandler(options.registry),
    );
    return router;
}
