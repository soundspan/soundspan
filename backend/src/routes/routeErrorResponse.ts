import type { Response } from "express";

export type RouteErrorExtras = Record<string, unknown>;

export const sendRouteError = (
    res: Response,
    statusCode: number,
    message: string,
    extras?: RouteErrorExtras
): Response => {
    if (extras && Object.keys(extras).length > 0) {
        return res.status(statusCode).json({
            error: message,
            ...extras,
        });
    }

    return res.status(statusCode).json({ error: message });
};

export const sendInternalRouteError = (
    res: Response,
    message: string,
    extras?: RouteErrorExtras
): Response => sendRouteError(res, 500, message, extras);
