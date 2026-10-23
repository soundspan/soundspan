import { Readable } from "stream";
import { BoundedLineSplitter } from "../backupLineSplitter";

const DEFAULT_OPTIONS = {
    maximumLineBytes: 64,
    maximumTotalBytes: 256,
};

async function split(chunks: Buffer[]): Promise<Buffer[]> {
    const splitter = new BoundedLineSplitter(DEFAULT_OPTIONS);
    const lines: Buffer[] = [];
    Readable.from(chunks).pipe(splitter);
    for await (const line of splitter) {
        lines.push(line as Buffer);
    }
    return lines;
}

describe("bounded backup line splitter", () => {
    it("emits Buffer lines without newlines", async () => {
        await expect(split([Buffer.from("first\nsecond\n")])).resolves.toEqual([
            Buffer.from("first"),
            Buffer.from("second"),
        ]);
    });

    it("emits a single-part line without copying it", () => {
        const input = Buffer.from("direct\n");
        const splitter = new BoundedLineSplitter(DEFAULT_OPTIONS);

        splitter.write(input);
        const emitted = splitter.read() as Buffer;

        expect(emitted.buffer).toBe(input.buffer);
        expect(emitted.byteOffset).toBe(input.byteOffset);
        splitter.destroy();
    });

    it("holds later chunks behind one unread line", () => {
        const splitter = new BoundedLineSplitter(DEFAULT_OPTIONS);

        splitter.write(Buffer.from("first\n"));
        const secondAccepted = splitter.write(Buffer.from("second\n"));
        const thirdAccepted = splitter.write(Buffer.from("third\n"));

        expect(splitter.readableLength).toBeLessThanOrEqual(1);
        expect(
            !secondAccepted || !thirdAccepted || splitter.writableLength > 0,
        ).toBe(true);
        splitter.destroy();
    });

    it("rejects a line above the per-line cap", async () => {
        await expect(
            split([Buffer.from(`${"x".repeat(65)}\n`)]),
        ).rejects.toThrow("Backup record exceeds the size limit");
    });

    it("rejects input above the total-byte cap", async () => {
        const splitter = new BoundedLineSplitter({
            maximumLineBytes: 64,
            maximumTotalBytes: 5,
        });
        Readable.from([Buffer.from("one\ntwo\n")]).pipe(splitter);

        await expect(
            (async () => {
                for await (const _line of splitter) {
                    // Consume until the total-byte bound is checked.
                }
            })(),
        ).rejects.toThrow("Backup expands beyond the supported size");
    });

    it("rejects an empty line", async () => {
        await expect(split([Buffer.from("\n")])).rejects.toThrow(
            "Backup contains an empty record",
        );
    });

    it("rejects unterminated trailing data", async () => {
        await expect(split([Buffer.from("trailing")])).rejects.toThrow(
            "Backup record is not newline terminated",
        );
    });

    it.each([
        [{ maximumLineBytes: 0, maximumTotalBytes: 1 }],
        [{ maximumLineBytes: 1.5, maximumTotalBytes: 2 }],
        [
            {
                maximumLineBytes: Number.MAX_SAFE_INTEGER + 1,
                maximumTotalBytes: 2,
            },
        ],
        [{ maximumLineBytes: 1, maximumTotalBytes: -1 }],
        [{ maximumLineBytes: 1, maximumTotalBytes: 1.5 }],
        [
            {
                maximumLineBytes: 1,
                maximumTotalBytes: Number.MAX_SAFE_INTEGER + 1,
            },
        ],
    ])("rejects invalid constructor options %p", (options) => {
        expect(() => new BoundedLineSplitter(options)).toThrow(
            "Backup line limits must be positive safe integers",
        );
    });
});
