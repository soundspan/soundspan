jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import sharp from "sharp";
import {
    COVER_ART_SIZES,
    negotiateCoverArtFormat,
    resizeCoverArt,
    snapCoverArtSize,
} from "../coverArtResize";

async function makeImage(
    width: number,
    height: number,
    format: "jpeg" | "png" = "jpeg"
): Promise<Buffer> {
    const pipeline = sharp({
        create: {
            width,
            height,
            channels: 3,
            background: { r: 30, g: 60, b: 120 },
        },
    });
    return format === "png"
        ? pipeline.png().toBuffer()
        : pipeline.jpeg().toBuffer();
}

describe("snapCoverArtSize", () => {
    it("snaps requested sizes up to the nearest allowed size", () => {
        expect(snapCoverArtSize("300")).toBe(320);
        expect(snapCoverArtSize("100")).toBe(128);
        expect(snapCoverArtSize(64)).toBe(64);
        expect(snapCoverArtSize("768")).toBe(768);
    });

    it("caps oversized requests at the largest allowed size", () => {
        expect(snapCoverArtSize("3000")).toBe(
            COVER_ART_SIZES[COVER_ART_SIZES.length - 1]
        );
    });

    it("returns null for missing or invalid sizes", () => {
        expect(snapCoverArtSize(undefined)).toBeNull();
        expect(snapCoverArtSize("")).toBeNull();
        expect(snapCoverArtSize("abc")).toBeNull();
        expect(snapCoverArtSize("0")).toBeNull();
        expect(snapCoverArtSize("-64")).toBeNull();
    });

    it("uses the first value when the query param is an array", () => {
        expect(snapCoverArtSize(["150", "700"])).toBe(192);
    });
});

describe("negotiateCoverArtFormat", () => {
    it("selects webp when the Accept header allows it", () => {
        expect(
            negotiateCoverArtFormat("image/avif,image/webp,image/*,*/*;q=0.8")
        ).toBe("webp");
    });

    it("keeps the original format otherwise", () => {
        expect(negotiateCoverArtFormat("image/png,image/*;q=0.8")).toBe(
            "original"
        );
        expect(negotiateCoverArtFormat(undefined)).toBe("original");
    });
});

describe("resizeCoverArt", () => {
    it("downscales large images to the requested size preserving aspect", async () => {
        const input = await makeImage(1000, 500);

        const result = await resizeCoverArt({
            buffer: input,
            contentType: "image/jpeg",
            size: 320,
            format: "original",
        });

        expect(result.resized).toBe(true);
        const meta = await sharp(result.buffer).metadata();
        expect(meta.width).toBe(320);
        expect(meta.height).toBe(160);
        expect(meta.format).toBe("jpeg");
        expect(result.contentType).toBe("image/jpeg");
    });

    it("never upscales images smaller than the requested size", async () => {
        const input = await makeImage(100, 100);

        const result = await resizeCoverArt({
            buffer: input,
            contentType: "image/jpeg",
            size: 512,
            format: "original",
        });

        const meta = await sharp(result.buffer).metadata();
        expect(meta.width).toBe(100);
        expect(meta.height).toBe(100);
    });

    it("converts to webp when the negotiated format is webp", async () => {
        const input = await makeImage(800, 800);

        const result = await resizeCoverArt({
            buffer: input,
            contentType: "image/jpeg",
            size: 192,
            format: "webp",
        });

        expect(result.resized).toBe(true);
        const meta = await sharp(result.buffer).metadata();
        expect(meta.format).toBe("webp");
        expect(meta.width).toBe(192);
        expect(result.contentType).toBe("image/webp");
    });

    it("keeps png output for png input when format is original", async () => {
        const input = await makeImage(600, 600, "png");

        const result = await resizeCoverArt({
            buffer: input,
            contentType: "image/png",
            size: 128,
            format: "original",
        });

        const meta = await sharp(result.buffer).metadata();
        expect(meta.format).toBe("png");
        expect(result.contentType).toBe("image/png");
    });

    it("returns the original buffer untouched when no size is requested", async () => {
        const input = await makeImage(1000, 1000);

        const result = await resizeCoverArt({
            buffer: input,
            contentType: "image/jpeg",
            size: null,
            format: "webp",
        });

        expect(result.resized).toBe(false);
        expect(result.buffer).toBe(input);
        expect(result.contentType).toBe("image/jpeg");
    });

    it("falls back to the original buffer when the input is not an image", async () => {
        const input = Buffer.from("definitely-not-an-image");

        const result = await resizeCoverArt({
            buffer: input,
            contentType: "image/jpeg",
            size: 320,
            format: "webp",
        });

        expect(result.resized).toBe(false);
        expect(result.buffer).toBe(input);
        expect(result.contentType).toBe("image/jpeg");
    });
});
