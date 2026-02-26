let isRuntimeDraining = false;

/** Returns whether this API process is in drain mode and should reject new intake. */
export function getRuntimeDrainState(): boolean {
    return isRuntimeDraining;
}

/** Sets drain mode for this process; readiness probes should fail while enabled. */
export function setRuntimeDrainState(value: boolean): void {
    isRuntimeDraining = value;
}
