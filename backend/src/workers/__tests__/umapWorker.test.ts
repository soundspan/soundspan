type LoadUmapWorkerOptions = {
    embeddings?: number[][];
    nNeighbors?: number;
    fitResult?: number[][];
    fitError?: unknown;
};

describe("umapWorker", () => {
    const defaultEmbeddings = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
    ];
    const defaultProjection = [
        [1, 2],
        [3, 4],
    ];

    afterEach(() => {
        jest.resetModules();
        jest.restoreAllMocks();
    });

    function loadUmapWorker(options: LoadUmapWorkerOptions = {}) {
        const postMessage = jest.fn();
        const fit = jest.fn(() => {
            if (options.fitError) {
                throw options.fitError;
            }

            return options.fitResult ?? defaultProjection;
        });
        const UMAP = jest.fn(() => ({ fit }));

        jest.doMock("worker_threads", () => ({
            parentPort: { postMessage },
            workerData: {
                embeddings: options.embeddings ?? defaultEmbeddings,
                nNeighbors: options.nNeighbors ?? 15,
            },
        }));

        jest.doMock("umap-js", () => ({ UMAP }));

        const exitSpy = jest
            .spyOn(process, "exit")
            .mockImplementation(((code?: string | number | null | undefined): never => {
                throw new Error(`process.exit:${code}`);
            }) as typeof process.exit);

        let moduleError: unknown;

        jest.isolateModules(() => {
            try {
                require("../umapWorker");
            } catch (error) {
                moduleError = error;
            }
        });

        return {
            postMessage,
            fit,
            UMAP,
            exitSpy,
            moduleError,
        };
    }

    it.each([2, 15, 50])(
        "creates UMAP with the expected parameters for nNeighbors=%i",
        (nNeighbors) => {
            const { UMAP } = loadUmapWorker({ nNeighbors });

            expect(UMAP).toHaveBeenCalledWith({
                nComponents: 2,
                nNeighbors,
                minDist: 0.1,
                spread: 1.0,
            });
        }
    );

    it("calls fit with embeddings from workerData", () => {
        const embeddings = [
            [9, 8, 7],
            [6, 5, 4],
        ];
        const { fit } = loadUmapWorker({ embeddings });

        expect(fit).toHaveBeenCalledWith(embeddings);
    });

    it("posts the projection result back through parentPort", () => {
        const fitResult = [
            [0.11, 0.22],
            [0.33, 0.44],
        ];
        const { postMessage, exitSpy } = loadUmapWorker({ fitResult });

        expect(postMessage).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledWith(fitResult);
        expect(exitSpy).not.toHaveBeenCalled();
    });

    it("posts the error message and exits with code 1 when fitting fails", () => {
        const { postMessage, exitSpy, moduleError } = loadUmapWorker({
            fitError: new Error("fit failed"),
        });

        expect(postMessage).toHaveBeenCalledTimes(1);
        expect(postMessage).toHaveBeenCalledWith({ error: "fit failed" });
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(moduleError).toBeInstanceOf(Error);
        expect((moduleError as Error).message).toBe("process.exit:1");
    });
});
