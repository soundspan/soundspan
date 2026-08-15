import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mockExecFile = jest.fn();

jest.mock("child_process", () => ({
    ...jest.requireActual("child_process"),
    execFile: (...args: unknown[]) => mockExecFile(...args),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: jest.fn(() => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        })),
    },
}));

jest.mock("../../config", () => ({
    config: {
        segmentedStreaming: {
            ffmpegPathOverride: process.env.FFMPEG_PATH?.trim() || undefined,
        },
    },
}));

jest.mock("../../utils/configValidator", () => ({
    resolveFfmpegBinaryPath: (configured?: string) =>
        configured?.trim() || "/usr/bin/ffmpeg",
}));

import { computeAudioStreamHash } from "../audioHash";

type ExecFileCallback = (
    error: Error | null,
    stdout: string,
    stderr: string,
) => void;

function mockExecFileResult(
    error: Error | null,
    stdout: string,
    stderr = "",
): void {
    mockExecFile.mockImplementation(
        (
            _bin: string,
            _args: string[],
            _opts: Record<string, unknown>,
            callback: ExecFileCallback,
        ) => {
            callback(error, stdout, stderr);
            return { on: jest.fn() };
        },
    );
}

describe("computeAudioStreamHash (unit)", () => {
    beforeEach(() => {
        mockExecFile.mockReset();
    });

    it("returns an algorithm-prefixed lowercase hash from streamhash output", async () => {
        mockExecFileResult(
            null,
            "0,a,SHA256=301ED5B7E54808DBB8B3DE0B57A05D5CDAB1BCC69E1594E414952E6D2CEC59E8\n",
        );

        const hash = await computeAudioStreamHash("/music/a.flac");

        expect(hash).toBe(
            "sha256:301ed5b7e54808dbb8b3de0b57a05d5cdab1bcc69e1594e414952e6d2cec59e8",
        );
    });

    it("invokes ffmpeg demux-only against the first audio stream", async () => {
        mockExecFileResult(null, "0,a,SHA256=abc123\n");

        await computeAudioStreamHash("/music/a.flac");

        expect(mockExecFile).toHaveBeenCalledTimes(1);
        const [, args] = mockExecFile.mock.calls[0] as [string, string[]];
        expect(args).toEqual(
            expect.arrayContaining([
                "-map",
                "0:a:0",
                "-c",
                "copy",
                "-f",
                "streamhash",
                "/music/a.flac",
            ]),
        );
        // Never decode: -c copy must be present, and no encoder args.
        expect(args).not.toContain("-c:a");
    });

    it("returns null when ffmpeg exits with an error (corrupt/no-audio file)", async () => {
        mockExecFileResult(
            new Error("ffmpeg exited with code 1"),
            "",
            "Stream map '0:a:0' matches no streams",
        );

        const hash = await computeAudioStreamHash("/music/broken.flac");

        expect(hash).toBeNull();
    });

    it("returns null when the output has no parsable hash line", async () => {
        mockExecFileResult(null, "unexpected output\n");

        const hash = await computeAudioStreamHash("/music/a.flac");

        expect(hash).toBeNull();
    });

    it("bounds the ffmpeg invocation with a timeout", async () => {
        mockExecFileResult(null, "0,a,SHA256=abc123\n");

        await computeAudioStreamHash("/music/a.flac");

        const [, , opts] = mockExecFile.mock.calls[0] as [
            string,
            string[],
            { timeout?: number },
        ];
        expect(opts.timeout).toBeGreaterThan(0);
    });
});

const FFMPEG = process.env.FFMPEG_PATH?.trim() || "/usr/bin/ffmpeg";
const ffmpegAvailable = fs.existsSync(FFMPEG);
const describeIntegration = ffmpegAvailable ? describe : describe.skip;

describeIntegration("computeAudioStreamHash (real ffmpeg)", () => {
    let tmpDir: string;
    let original: string;
    let retagged: string;

    beforeAll(() => {
        // Real subprocesses in this suite: restore the actual execFile.
        mockExecFile.mockImplementation((...args: unknown[]) => {
            const real = jest.requireActual("child_process").execFile as (
                ...a: unknown[]
            ) => unknown;
            return real(...args);
        });

        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audiohash-"));
        original = path.join(tmpDir, "original.flac");
        retagged = path.join(tmpDir, "retagged.flac");
        execFileSync(FFMPEG, [
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anoisesrc=d=2:c=pink",
            "-c:a",
            "flac",
            "-y",
            original,
        ]);
        execFileSync(FFMPEG, [
            "-v",
            "error",
            "-i",
            original,
            "-c",
            "copy",
            "-metadata",
            "title=Retagged",
            "-metadata",
            "artist=Someone Else",
            "-y",
            retagged,
        ]);
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("produces identical hashes for a file and its retagged copy", async () => {
        const hashOriginal = await computeAudioStreamHash(original);
        const hashRetagged = await computeAudioStreamHash(retagged);

        expect(hashOriginal).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(hashRetagged).toBe(hashOriginal);
    });

    it("returns null for a file that is not audio", async () => {
        const notAudio = path.join(tmpDir, "not-audio.flac");
        fs.writeFileSync(notAudio, "this is not a flac file");

        await expect(computeAudioStreamHash(notAudio)).resolves.toBeNull();
    });
});
