import express, { type RequestHandler } from "express";
import { RESTORE_CHUNK_SIZE_BYTES } from "../services/backup/restoreUploads";
import { sendRouteError } from "../utils/routeErrorResponse";

const rawChunkParser = express.raw({
    type: "application/octet-stream",
    limit: RESTORE_CHUNK_SIZE_BYTES,
});

/** Parse one exact binary restore chunk and canonicalize parser failures. */
export const parseRestoreChunk: RequestHandler = (req, res, next) => {
    rawChunkParser(req, res, (error) => {
        if (!error) {
            next();
            return;
        }
        sendRouteError(res, 400, "Restore chunk size is invalid", {
            code: "RESTORE_CHUNK_SIZE",
        });
    });
};
