import { NextFunction, Request, Response } from "express";

/** Makes form-encoded OpenSubsonic POST parameters available to query-based handlers. */
export function appendSubsonicBodyParamsToUrl(
    req: Request,
    _res: Response,
    next: NextFunction,
): void {
    if (req.method !== "POST" || !isRecord(req.body)) {
        next();
        return;
    }
    const queryIndex = req.url.indexOf("?");
    const existingParams = new URLSearchParams(queryIndex === -1 ? "" : req.url.slice(queryIndex + 1));
    const bodyParams = new URLSearchParams();
    for (const [key, value] of Object.entries(req.body)) {
        if (existingParams.has(key)) continue;
        if (typeof value === "string") bodyParams.append(key, value);
        else if (Array.isArray(value)) {
            for (const item of value) if (typeof item === "string") bodyParams.append(key, item);
        }
    }
    const serialized = bodyParams.toString();
    if (serialized) req.url += `${queryIndex === -1 ? "?" : "&"}${serialized}`;
    next();
}
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
