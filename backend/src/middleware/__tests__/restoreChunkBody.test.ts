import { PassThrough } from "node:stream";

jest.mock("../../services/backup/restoreUploads", () => ({
    RESTORE_CHUNK_SIZE_BYTES: 4 * 1024 * 1024,
}));

import { parseRestoreChunk } from "../restoreChunkBody";

describe("restore chunk body parser", () => {
    async function parse(bytes: Buffer, contentLength = bytes.length) {
        const req = Object.assign(new PassThrough(), {
            headers: {
                "content-type": "application/octet-stream",
                "content-length": String(contentLength),
            },
            method: "PUT",
            url: "/chunk",
            body: undefined as unknown,
        });
        let complete: (() => void) | undefined;
        const completed = new Promise<void>((resolve) => {
            complete = resolve;
        });
        const next = jest.fn(() => complete?.());
        const res = {
            statusCode: 200,
            body: undefined as unknown,
            status(code: number) {
                this.statusCode = code;
                return this;
            },
            json(body: unknown) {
                this.body = body;
                complete?.();
                return this;
            },
        };
        parseRestoreChunk(req as any, res as any, next);
        req.end(bytes);
        await completed;
        return { req, res, next };
    }

    it("parses an exact binary request body", async () => {
        const result = await parse(Buffer.from([1, 2, 3]));
        expect(result.next).toHaveBeenCalledTimes(1);
        expect(result.req.body).toEqual(Buffer.from([1, 2, 3]));
    });

    it("maps an oversized body to the canonical chunk error", async () => {
        const result = await parse(Buffer.alloc(0), 4 * 1024 * 1024 + 1);
        expect(result.res.statusCode).toBe(400);
        expect(result.res.body).toEqual({
            error: "Restore chunk size is invalid",
            code: "RESTORE_CHUNK_SIZE",
        });
    });
});
