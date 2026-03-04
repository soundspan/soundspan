import assert from "node:assert/strict";
import test from "node:test";
import { isGenreCategory } from "../../features/explore/genreClassification";

test("isGenreCategory identifies genre keywords", () => {
    assert.equal(isGenreCategory("Pop"), true);
    assert.equal(isGenreCategory("Rock"), true);
    assert.equal(isGenreCategory("Hip-Hop"), true);
    assert.equal(isGenreCategory("Electronic"), true);
    assert.equal(isGenreCategory("K-Pop Hits"), true);
    assert.equal(isGenreCategory("Jazz & Blues"), true);
});

test("isGenreCategory rejects mood titles", () => {
    assert.equal(isGenreCategory("Chill"), false);
    assert.equal(isGenreCategory("Workout"), false);
    assert.equal(isGenreCategory("Focus"), false);
    assert.equal(isGenreCategory("Party"), false);
    assert.equal(isGenreCategory("Romance"), false);
    assert.equal(isGenreCategory("Sleep"), false);
});

test("isGenreCategory is case-insensitive", () => {
    assert.equal(isGenreCategory("POP"), true);
    assert.equal(isGenreCategory("rock"), true);
    assert.equal(isGenreCategory("ELECTRONIC"), true);
});

test("isGenreCategory avoids false positives from substring matches", () => {
    assert.equal(isGenreCategory("Popular"), false);
    assert.equal(isGenreCategory("Rockin' Vibes"), false);
    assert.equal(isGenreCategory("Metalwork"), false);
    assert.equal(isGenreCategory("Soulful"), false);
    assert.equal(isGenreCategory("Folksy Tunes"), false);
});
