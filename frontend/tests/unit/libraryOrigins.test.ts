import assert from "node:assert/strict";
import test from "node:test";
import {
    getLibraryOriginLabel,
    listLibraryOrigins,
    resolveLibraryOrigin,
} from "../../features/library/libraryOrigins";

test("no selector when neither peers nor streaming providers are available", () => {
    assert.deepEqual(
        listLibraryOrigins({ federation: false, remote: false }),
        [],
    );
});

test("federation alone offers All, Local, and Peers", () => {
    assert.deepEqual(listLibraryOrigins({ federation: true, remote: false }), [
        "all",
        "local",
        "peers",
    ]);
});

test("a connected provider offers Remote without federation", () => {
    assert.deepEqual(listLibraryOrigins({ federation: false, remote: true }), [
        "all",
        "local",
        "remote",
    ]);
});

test("federation and a connected provider offer every origin", () => {
    assert.deepEqual(listLibraryOrigins({ federation: true, remote: true }), [
        "all",
        "local",
        "peers",
        "remote",
    ]);
});

test("an origin that is no longer offered falls back to All", () => {
    assert.equal(
        resolveLibraryOrigin("remote", ["all", "local", "peers"]),
        "all",
    );
    assert.equal(resolveLibraryOrigin("peers", []), "all");
    assert.equal(resolveLibraryOrigin("local", []), "all");
});

test("an offered origin is kept", () => {
    assert.equal(
        resolveLibraryOrigin("remote", ["all", "local", "remote"]),
        "remote",
    );
    assert.equal(resolveLibraryOrigin("all", []), "all");
});

test("origin labels are human readable", () => {
    assert.equal(getLibraryOriginLabel("all"), "All");
    assert.equal(getLibraryOriginLabel("local"), "Local");
    assert.equal(getLibraryOriginLabel("peers"), "Peers");
    assert.equal(getLibraryOriginLabel("remote"), "Remote");
});
