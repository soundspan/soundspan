"use client";

/** Presentational root for the composed VibeMap controller. */

import type { CSSProperties, RefObject } from "react";
import { VibeMapCanvasStage } from "./VibeMapCanvasStage";
import { VibeMapControlsSurface } from "./VibeMapControlsSurface";
import { VibeMapFeedback } from "./VibeMapFeedback";
import type { VibeMapViewModel } from "./useVibeMapController";

/** Render the full map surface without owning interaction state. */
export function VibeMapView({ model, containerRef }: {
    model: VibeMapViewModel;
    containerRef: RefObject<HTMLDivElement | null>;
}) {
    const className = model.shell.fullscreen ?
        "fixed inset-0 z-[10005] bg-[#0a0a0a] overflow-hidden" :
        "relative w-full h-full overflow-hidden";
    const bottomInset = model.shell.fullscreen ? 0 : model.props.bottomInset ?? 0;
    return (
        <div className={className}
            style={{ "--vibe-binset": `${bottomInset}px` } as CSSProperties}
            data-vibe-mode={model.vibe.mode}>
            <VibeMapCanvasStage model={model} containerRef={containerRef} />
            <VibeMapControlsSurface model={model} />
            <VibeMapFeedback model={model} />
        </div>
    );
}
