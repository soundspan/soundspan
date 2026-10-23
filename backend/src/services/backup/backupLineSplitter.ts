import { Transform, type TransformCallback } from "stream";
import { BackupFormatError } from "./backupErrors";

interface BoundedLineSplitterOptions {
    maximumLineBytes: number;
    maximumTotalBytes: number;
}

function validateOptions(
    options: BoundedLineSplitterOptions,
): BoundedLineSplitterOptions {
    if (
        !Number.isSafeInteger(options.maximumLineBytes) ||
        options.maximumLineBytes <= 0 ||
        !Number.isSafeInteger(options.maximumTotalBytes) ||
        options.maximumTotalBytes <= 0
    ) {
        throw new RangeError(
            "Backup line limits must be positive safe integers",
        );
    }
    return options;
}

/** Split newline-framed backup records while bounding line and stream bytes. */
export class BoundedLineSplitter extends Transform {
    private readonly parts: Buffer[] = [];
    private readonly maximumLineBytes: number;
    private readonly maximumTotalBytes: number;
    private bufferedBytes = 0;
    private totalBytes = 0;

    constructor(options: BoundedLineSplitterOptions) {
        const validated = validateOptions(options);
        // The restore consumer awaits one database round trip per record.
        super({ readableObjectMode: true, readableHighWaterMark: 1 });
        this.maximumLineBytes = validated.maximumLineBytes;
        this.maximumTotalBytes = validated.maximumTotalBytes;
    }

    override _transform(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: TransformCallback,
    ): void {
        try {
            this.countChunk(chunk);
            this.consumeChunk(chunk);
            callback();
        } catch (error) {
            callback(error as Error);
        }
    }

    override _flush(callback: TransformCallback): void {
        if (this.bufferedBytes !== 0) {
            callback(
                new BackupFormatError(
                    "Backup record is not newline terminated",
                ),
            );
            return;
        }
        callback();
    }

    private countChunk(chunk: Buffer): void {
        const nextTotal = this.totalBytes + chunk.length;
        if (nextTotal > this.maximumTotalBytes) {
            throw new BackupFormatError(
                "Backup expands beyond the supported size",
            );
        }
        this.totalBytes = nextTotal;
    }

    private addPart(part: Buffer): void {
        if (part.length === 0) return;
        this.parts.push(part);
        this.bufferedBytes += part.length;
        if (this.bufferedBytes > this.maximumLineBytes) {
            throw new BackupFormatError("Backup record exceeds the size limit");
        }
    }

    private emitLine(part: Buffer): void {
        this.addPart(part);
        if (this.bufferedBytes === 0) {
            throw new BackupFormatError("Backup contains an empty record");
        }
        const line =
            this.parts.length === 1
                ? this.parts[0]
                : Buffer.concat(this.parts, this.bufferedBytes);
        this.push(line);
        this.parts.length = 0;
        this.bufferedBytes = 0;
    }

    private consumeChunk(chunk: Buffer): void {
        let offset = 0;
        for (
            let lineCount = 0;
            lineCount < this.maximumTotalBytes;
            lineCount += 1
        ) {
            const newline = chunk.indexOf(0x0a, offset);
            if (newline === -1) break;
            this.emitLine(chunk.subarray(offset, newline));
            offset = newline + 1;
        }
        this.addPart(chunk.subarray(offset));
    }
}
