import { escapeLikePattern } from "../likePattern";

describe("escapeLikePattern", () => {
    it.each([
        ["%", "\\%"],
        ["_", "\\_"],
        ["\\", "\\\\"],
        ["rock", "rock"],
        ["50%_r\\ock", "50\\%\\_r\\\\ock"],
        ["", ""],
    ])("escapes %j as %j", (value, expected) => {
        expect(escapeLikePattern(value)).toBe(expected);
    });
});
