import assert from "node:assert/strict";
import test from "node:test";
import { selectFeaturedRadioGenres } from "../../features/home/components/libraryRadioStationsGenreSelection";

test("keeps soundtrack genres visible when they meet radio minimums", () => {
    const featured = selectFeaturedRadioGenres([
        { genre: "rock", count: 120 },
        { genre: "pop", count: 110 },
        { genre: "hip hop", count: 95 },
        { genre: "indie", count: 90 },
        { genre: "electronic", count: 80 },
        { genre: "jazz", count: 70 },
        { genre: "soundtracks", count: 65 },
    ]);

    assert.ok(
        featured.some((genre) => genre.genre === "soundtracks"),
        "Expected qualifying soundtrack genre to stay visible"
    );
    assert.equal(featured.length, 6);
});

test("does not include soundtrack genres below the minimum track threshold", () => {
    const featured = selectFeaturedRadioGenres([
        { genre: "rock", count: 40 },
        { genre: "soundtracks", count: 12 },
        { genre: "jazz", count: 30 },
    ]);

    assert.ok(
        !featured.some((genre) => genre.genre === "soundtracks"),
        "Expected below-threshold soundtrack genre to stay hidden"
    );
});
