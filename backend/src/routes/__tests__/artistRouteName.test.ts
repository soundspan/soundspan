import { findRouteNameMatch, normalizeRouteName } from "../artistRouteName";

describe("normalizeRouteName", () => {
    it.each([
        ["100% Pure", ["100% Pure"]],
        ["A/B", ["A/B"]],
        ["Earth, Wind & Fire", ["Earth, Wind & Fire"]],
        ["Björk", ["Björk"]],
        ["A%2FB", ["A%2FB", "A/B"]],
        ["Legacy%20Artist", ["Legacy%20Artist", "Legacy Artist"]],
        ["incomplete%2", ["incomplete%2"]],
    ])("returns ordered candidates for %s", (raw, expected) => {
        expect(normalizeRouteName(raw)).toEqual(expected);
    });
});

describe("findRouteNameMatch", () => {
    it("tries the raw name before the legacy decoded fallback", async () => {
        const lookup = jest.fn(async (candidate: string) =>
            candidate === "Legacy Artist" ? candidate : null,
        );

        await expect(
            findRouteNameMatch("Legacy%20Artist", lookup),
        ).resolves.toBe("Legacy Artist");
        expect(lookup.mock.calls).toEqual([
            ["Legacy%20Artist"],
            ["Legacy Artist"],
        ]);
    });

    it("does not decode after the raw name matches", async () => {
        const lookup = jest.fn(async (candidate: string) => candidate);

        await expect(findRouteNameMatch("A%2FB", lookup)).resolves.toBe(
            "A%2FB",
        );
        expect(lookup).toHaveBeenCalledTimes(1);
    });
});
