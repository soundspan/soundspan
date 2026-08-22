import { federationInstanceNameSchema } from "../systemSettingsFederationSchema";

describe("federation instance name settings schema", () => {
    it.each(["", "   ", null])("normalizes %p to null", (value) => {
        expect(federationInstanceNameSchema.parse(value)).toBeNull();
    });

    it("accepts a 100-character name", () => {
        const name = "x".repeat(100);

        expect(federationInstanceNameSchema.parse(name)).toBe(name);
    });

    it("rejects a 101-character name", () => {
        expect(() =>
            federationInstanceNameSchema.parse("x".repeat(101)),
        ).toThrow();
    });
});
