"use client";

import { ReactNode } from "react";
import { usePlayerMode } from "@/hooks/usePlayerMode";

/**
 * Renders the PlayerModeWrapper component.
 */
export function PlayerModeWrapper({ children }: { children: ReactNode }) {
    // This component exists solely to call the usePlayerMode hook
    // which must be in a client component
    usePlayerMode();
    return <>{children}</>;
}
