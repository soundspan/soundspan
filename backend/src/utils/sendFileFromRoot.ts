import path from "node:path";
import type { Response } from "express";
import type { Errback, SendFileOptions } from "express-serve-static-core";

function isPathWithinRoot(relativePath: string): boolean {
    return (
        relativePath.length > 0 &&
        relativePath !== ".." &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativePath)
    );
}

function createNotFoundError(): NodeJS.ErrnoException {
    const error = new Error("Not Found") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    return error;
}

/**
 * Sends an existing server-managed file relative to its canonical storage root.
 * Paths outside the root are rejected before Express receives the request.
 */
export function sendFileFromRoot(
    res: Response,
    filePath: string,
    rootDir: string,
    options: SendFileOptions = {},
    callback?: Errback,
): void {
    const absoluteRoot = path.resolve(rootDir);
    const relativePath = path.relative(absoluteRoot, path.resolve(filePath));
    if (!isPathWithinRoot(relativePath)) {
        if (callback) {
            callback(createNotFoundError());
        } else {
            res.status(404).end();
        }
        return;
    }

    const rootPinnedOptions: SendFileOptions = {
        ...options,
        dotfiles: "ignore",
        root: absoluteRoot,
    };
    if (callback) {
        res.sendFile(relativePath, rootPinnedOptions, callback);
    } else {
        res.sendFile(relativePath, rootPinnedOptions);
    }
}
