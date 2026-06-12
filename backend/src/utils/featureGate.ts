import type { RequestHandler } from "express";

/**
 * Builds the Express handler mounted at an API prefix whose feature flag is
 * disabled (see `config.features`).
 *
 * Responds 404 with a stable JSON body so clients can distinguish a disabled
 * feature from an unknown route.
 */
export function createFeatureDisabledHandler(): RequestHandler {
    return (_req, res) => {
        res.status(404).json({
            error: "feature disabled",
            code: "FEATURE_DISABLED",
        });
    };
}
