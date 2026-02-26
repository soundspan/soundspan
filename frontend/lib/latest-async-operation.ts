export interface LatestAsyncOperationState<TArg> {
    inFlight: boolean;
    hasQueuedArg: boolean;
    queuedArg: TArg | undefined;
}

export function createLatestAsyncOperationState<TArg>(): LatestAsyncOperationState<TArg> {
    return {
        inFlight: false,
        hasQueuedArg: false,
        queuedArg: undefined,
    };
}

export function enqueueLatestAsyncOperation<TArg>(
    state: LatestAsyncOperationState<TArg>,
    arg: TArg,
    runner: (arg: TArg) => Promise<void>,
    options?: {
        onError?: (error: unknown, arg: TArg) => void | Promise<void>;
    },
): void {
    state.hasQueuedArg = true;
    state.queuedArg = arg;
    if (state.inFlight) {
        return;
    }

    state.inFlight = true;
    const pump = async () => {
        try {
            while (state.hasQueuedArg) {
                const nextArg = state.queuedArg as TArg;
                state.hasQueuedArg = false;
                state.queuedArg = undefined;
                try {
                    await runner(nextArg);
                } catch (error) {
                    if (typeof options?.onError === "function") {
                        await options.onError(error, nextArg);
                    }
                }
            }
        } finally {
            state.inFlight = false;
            if (!state.hasQueuedArg) {
                return;
            }
            enqueueLatestAsyncOperation(
                state,
                state.queuedArg as TArg,
                runner,
                options,
            );
        }
    };

    void pump();
}
