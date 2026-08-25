import { asPlainObject, isPlainObject } from "../plainObject";

describe("plain object utilities", () => {
    it.each([{}, { value: 1 }, new Date()])(
        "accepts non-null, non-array objects",
        (value) => {
            expect(isPlainObject(value)).toBe(true);
            expect(asPlainObject(value)).toBe(value);
        },
    );

    it.each([null, undefined, [], "value", 42])(
        "rejects non-object and array values",
        (value) => {
            expect(isPlainObject(value)).toBe(false);
            expect(asPlainObject(value)).toEqual({});
        },
    );
});
