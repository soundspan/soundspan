import { NextFunction, Request, Response } from "express";

/**
 * Makes form-encoded OpenSubsonic POST parameters available to query-based
 * handlers. This must run before any other Subsonic middleware reads
 * `req.query`: Express parses that value lazily, so this middleware pins the
 * merged query object on the request for all subsequent middleware and routes.
 *
 * Body parameters do not replace same-named URL query parameters. In
 * particular, credentials remain in-process request data and are never copied
 * into `req.url`, which can be logged by other middleware.
 */
export function mergeSubsonicBodyParamsIntoQuery(
    req: Request,
    _res: Response,
    next: NextFunction,
): void {
    if (req.method !== "POST" || !isRecord(req.body)) {
        next();
        return;
    }
    const query = req.query as Record<string, unknown>;
    for (const [key, value] of Object.entries(req.body)) {
        if (
            key === "__proto__" ||
            key === "constructor" ||
            key === "prototype"
        ) {
            continue;
        }
        if (Object.hasOwn(query, key)) continue;
        if (typeof value === "string") query[key] = value;
        else if (
            Array.isArray(value) &&
            value.every((item) => typeof item === "string")
        ) {
            query[key] = value;
        }
    }
    Object.defineProperty(req, "query", { configurable: true, value: query });
    next();
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
