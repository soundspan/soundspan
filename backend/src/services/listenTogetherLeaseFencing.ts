/** Lease state passed explicitly through one locked group mutation. */
export interface GroupMutationFence {
    readonly fencingToken: number;
    /** True when the token is durable across processes and process restarts. */
    readonly requiresMembershipFence?: boolean;
    isFenced(): boolean;
    assertCurrent?(): Promise<void>;
}

/** State-store outcome for a token-guarded snapshot mutation. */
export type FencedStateWriteResult = "accepted" | "stale";
