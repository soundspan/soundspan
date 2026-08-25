import type { Response } from "express";
import type { Logger } from "./logger";

export type RouteErrorExtras = Record<string, unknown>;

export const sendRouteError = (
    res: Response,
    statusCode: number,
    message: string,
    extras?: RouteErrorExtras,
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
    extras?: RouteErrorExtras,
): Response => sendRouteError(res, 500, message, extras);

/** Exact route log and static client-response wording for an internal failure. */
export type RouteFailureOperation = readonly [
    logMessage: string,
    responseMessage: string,
];

/** Log an unexpected route failure and send its static 500 response. */
export const sendRouteFailure = (
    res: Response,
    log: Pick<Logger, "error">,
    operation: RouteFailureOperation | string,
    error: unknown,
): Response => {
    if (typeof operation === "string") {
        log.error(`${operation} failed`, { error });
        return sendInternalRouteError(res, `Failed to ${operation}`);
    }

    log.error(operation[0], error);
    return sendInternalRouteError(res, operation[1]);
};

interface ValidationResult {
    success: boolean;
}

/** Send the static 400 response associated with a failed validation result. */
export const sendValidationError = (
    res: Response,
    _result: ValidationResult,
    message = "Invalid request",
): Response => sendRouteError(res, 400, message);
