import path from "node:path";
import { safeResolvePath } from "../safeResolvePath";

const BASE = "/srv/covers";

describe("safeResolvePath", () => {
    it("returns the resolved path for a safe relative segment", () => {
        expect(safeResolvePath(BASE, "albums/abc.jpg")).toBe(
            path.join(BASE, "albums/abc.jpg")
        );
    });

    it("returns the resolved path for a filename with no subdirectory", () => {
        expect(safeResolvePath(BASE, "cover.jpg")).toBe(
            path.join(BASE, "cover.jpg")
        );
    });

    it("returns null for a single dot-dot segment", () => {
        expect(safeResolvePath(BASE, "../etc/passwd")).toBeNull();
    });

    it("returns null for deeply nested dot-dot traversal", () => {
        expect(safeResolvePath(BASE, "albums/../../etc/passwd")).toBeNull();
    });

    it("returns null for an absolute path that escapes base", () => {
        expect(safeResolvePath(BASE, "/etc/passwd")).toBeNull();
    });

    it("returns null for a sibling directory with a matching prefix", () => {
        expect(safeResolvePath("/srv/covers", "../covers-evil/file.jpg")).toBeNull();
    });

    it("returns null when the resolved path equals the base directory exactly", () => {
        expect(safeResolvePath(BASE, ".")).toBeNull();
        expect(safeResolvePath(BASE, "")).toBeNull();
    });

    it("handles a base path that itself contains dot-dot segments", () => {
        const unnormalizedBase = "/srv/cache/../covers";
        expect(safeResolvePath(unnormalizedBase, "albums/abc.jpg")).toBe(
            path.join("/srv/covers", "albums/abc.jpg")
        );
        expect(safeResolvePath(unnormalizedBase, "../etc/passwd")).toBeNull();
    });

    it("handles nested valid paths", () => {
        expect(safeResolvePath(BASE, "a/b/c/cover.png")).toBe(
            path.join(BASE, "a/b/c/cover.png")
        );
    });
});
