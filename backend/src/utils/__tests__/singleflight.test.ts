import { coalesceInFlightByKey } from "../singleflight";

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

const createDeferred = <T>(): Deferred<T> => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};

describe("coalesceInFlightByKey", () => {
    it("returns one promise and runs one factory for concurrent callers", async () => {
        const inFlight = new Map<string, Promise<string>>();
        const deferred = createDeferred<string>();
        const factory = jest.fn(() => deferred.promise);

        const first = coalesceInFlightByKey(inFlight, "track", factory);
        const second = coalesceInFlightByKey(inFlight, "track", factory);

        expect(second).toBe(first);
        await Promise.resolve();
        expect(factory).toHaveBeenCalledTimes(1);

        deferred.resolve("cached-path");
        await expect(Promise.all([first, second])).resolves.toEqual([
            "cached-path",
            "cached-path",
        ]);
    });

    it("clears a resolved flight so a later caller reruns the factory", async () => {
        const inFlight = new Map<string, Promise<number>>();
        const factory = jest
            .fn<Promise<number>, []>()
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(2);

        await expect(
            coalesceInFlightByKey(inFlight, "key", factory),
        ).resolves.toBe(1);
        expect(inFlight.has("key")).toBe(false);
        await expect(
            coalesceInFlightByKey(inFlight, "key", factory),
        ).resolves.toBe(2);
        expect(factory).toHaveBeenCalledTimes(2);
    });

    it("propagates rejection to joiners and clears the rejected flight", async () => {
        const inFlight = new Map<string, Promise<string>>();
        const deferred = createDeferred<string>();
        const error = new Error("factory failed");
        const factory = jest
            .fn<Promise<string>, []>()
            .mockImplementationOnce(() => deferred.promise)
            .mockResolvedValueOnce("recovered");

        const first = coalesceInFlightByKey(inFlight, "key", factory);
        const second = coalesceInFlightByKey(inFlight, "key", factory);
        deferred.reject(error);

        const results = await Promise.allSettled([first, second]);
        expect(results).toEqual([
            { status: "rejected", reason: error },
            { status: "rejected", reason: error },
        ]);
        expect(inFlight.has("key")).toBe(false);
        await expect(
            coalesceInFlightByKey(inFlight, "key", factory),
        ).resolves.toBe("recovered");
        expect(factory).toHaveBeenCalledTimes(2);
    });

    it("does not delete a replacement promise when an older flight settles", async () => {
        const inFlight = new Map<string, Promise<string>>();
        const deferred = createDeferred<string>();
        const first = coalesceInFlightByKey(
            inFlight,
            "key",
            () => deferred.promise,
        );
        const replacement = Promise.resolve("replacement");
        inFlight.set("key", replacement);

        deferred.resolve("original");
        await expect(first).resolves.toBe("original");
        expect(inFlight.get("key")).toBe(replacement);
    });

    it("invokes the coalesced-wait hook once per joining caller", async () => {
        const inFlight = new Map<string, Promise<void>>();
        const deferred = createDeferred<void>();
        const onCoalescedWait = jest.fn();

        const first = coalesceInFlightByKey(
            inFlight,
            "key",
            () => deferred.promise,
            { onCoalescedWait },
        );
        expect(onCoalescedWait).not.toHaveBeenCalled();
        const second = coalesceInFlightByKey(inFlight, "key", jest.fn(), {
            onCoalescedWait,
        });
        const third = coalesceInFlightByKey(inFlight, "key", jest.fn(), {
            onCoalescedWait,
        });

        expect(onCoalescedWait).toHaveBeenCalledTimes(2);
        deferred.resolve();
        await Promise.all([first, second, third]);
    });

    it("runs factories independently for different keys", async () => {
        const inFlight = new Map<string, Promise<string>>();
        const firstFactory = jest.fn(async () => "first");
        const secondFactory = jest.fn(async () => "second");

        await expect(
            Promise.all([
                coalesceInFlightByKey(inFlight, "first", firstFactory),
                coalesceInFlightByKey(inFlight, "second", secondFactory),
            ]),
        ).resolves.toEqual(["first", "second"]);
        expect(firstFactory).toHaveBeenCalledTimes(1);
        expect(secondFactory).toHaveBeenCalledTimes(1);
    });
});
