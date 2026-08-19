import assert from "node:assert/strict";
import { test } from "node:test";
import {
    deriveDiscoverySelection,
    normalizeArtistName,
} from "../../features/search/discoverySelection";
import type { DiscoverResult } from "../../features/search/types";

const artist = (name: string, mbid?: string): DiscoverResult => ({
    type: "music",
    name,
    mbid,
});

const track = (name: string, artistName: string): DiscoverResult => ({
    type: "track",
    name,
    artist: artistName,
});

test("normalizeArtistName strips case, whitespace, and diacritics", () => {
    assert.equal(normalizeArtistName("  Björk "), "bjork");
    assert.equal(normalizeArtistName("DRAKE"), "drake");
});

test("exact external match beats a fuzzy library match", () => {
    const selection = deriveDiscoverySelection({
        discoverResults: [artist("Drake", "mbid-1"), artist("Drake Bell")],
        query: "drake",
        aliasCanonical: null,
        libraryTopName: "Nick Drake",
        showDiscover: true,
    });

    assert.equal(selection.topArtist?.name, "Drake");
    assert.equal(selection.preferDiscovery, true);
    assert.equal(selection.discoveryShownAsTop, true);
    assert.deepEqual(
        selection.secondaryArtists.map((a) => a.name),
        ["Drake Bell"],
    );
});

test("an exact library match keeps the library artist on top", () => {
    const selection = deriveDiscoverySelection({
        discoverResults: [artist("Drake Bell")],
        query: "drake",
        aliasCanonical: null,
        libraryTopName: "Drake",
        showDiscover: true,
    });

    assert.equal(selection.preferDiscovery, false);
    // The library side wins, so no external artist is consumed by the
    // top result and all of them stay in the Artists section.
    assert.equal(selection.discoveryShownAsTop, false);
    assert.deepEqual(
        selection.secondaryArtists.map((a) => a.name),
        ["Drake Bell"],
    );
});

test("alias-corrected queries count as exact matches", () => {
    // "beatles" only matches "The Beatles" through the alias canonical,
    // not through normalization, so this pins the alias path itself.
    const selection = deriveDiscoverySelection({
        discoverResults: [artist("The Beatles", "mbid-b")],
        query: "beatles",
        aliasCanonical: "The Beatles",
        libraryTopName: "Beatallica",
        showDiscover: true,
    });

    assert.equal(selection.topArtist?.name, "The Beatles");
    assert.equal(selection.preferDiscovery, true);
});

test("diacritic-only differences count as exact without an alias", () => {
    const selection = deriveDiscoverySelection({
        discoverResults: [artist("Björk", "mbid-bj")],
        query: "bjork",
        aliasCanonical: null,
        libraryTopName: "Bjorn Again",
        showDiscover: true,
    });

    assert.equal(selection.topArtist?.name, "Björk");
    assert.equal(selection.preferDiscovery, true);
});

test("library and peers filters select nothing external", () => {
    const selection = deriveDiscoverySelection({
        discoverResults: [artist("Drake"), track("Headlines", "Drake")],
        query: "drake",
        aliasCanonical: null,
        libraryTopName: "Nick Drake",
        showDiscover: false,
    });

    assert.equal(selection.topArtist, undefined);
    assert.equal(selection.preferDiscovery, false);
    assert.deepEqual(selection.secondaryArtists, []);
    assert.deepEqual(selection.tracks, []);
});

test("no library artist means the external top comes off the artist list", () => {
    const selection = deriveDiscoverySelection({
        discoverResults: [artist("Drake"), artist("Drake Bell")],
        query: "drizzy",
        aliasCanonical: null,
        libraryTopName: null,
        showDiscover: true,
    });

    assert.equal(selection.topArtist?.name, "Drake");
    assert.equal(selection.discoveryShownAsTop, true);
    assert.deepEqual(
        selection.secondaryArtists.map((a) => a.name),
        ["Drake Bell"],
    );
});

test("tracks pass through when discovery is visible", () => {
    const selection = deriveDiscoverySelection({
        discoverResults: [track("Headlines", "Drake")],
        query: "headlines",
        aliasCanonical: null,
        libraryTopName: null,
        showDiscover: true,
    });

    assert.equal(selection.tracks.length, 1);
    assert.equal(selection.topArtist, undefined);
});
