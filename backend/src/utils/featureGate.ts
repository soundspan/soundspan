import type { RequestHandler, Response } from "express";

/**
 * Sends the standard feature-disabled response — 404 with a stable JSON body
 * (`code: FEATURE_DISABLED`) — for an individual route whose backing
 * subsystem is turned off via `config.features`.
 */
export function sendFeatureDisabled(res: Response): void {
    res.status(404).json({
        error: "feature disabled",
        code: "FEATURE_DISABLED",
    });
}

/**
 * Builds the Express handler mounted at an API prefix whose feature flag is
 * disabled (see `config.features`).
 *
 * Responds 404 with a stable JSON body so clients can distinguish a disabled
 * feature from an unknown route.
 */
export function createFeatureDisabledHandler(): RequestHandler {
    return (_req, res) => {
        sendFeatureDisabled(res);
    };
}
