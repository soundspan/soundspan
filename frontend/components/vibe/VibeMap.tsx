"use client";

/** Thin public container for the decomposed interactive vibe-map surface. */

import type { ReactNode } from "react";
import { useVibeMapController } from "./useVibeMapController";
import { VibeMapView } from "./VibeMapView";

/** Mobile mini-player clearance applied by the host page. */
export const MOBILE_PLAYER_CLEARANCE_PX = 64;

export interface VibeMapProps {
    /** Host navigation rendered in the map's top-left chrome. */
    headerSlot?: ReactNode;
    /** Extra bottom clearance for a fixed host surface. */
    bottomInset?: number;
}

/** Render the interactive library embedding navigator. */
export function VibeMap(props: VibeMapProps = {}) {
    const controller = useVibeMapController(props);
    return <VibeMapView model={controller.view} containerRef={controller.containerRef} />;
}
