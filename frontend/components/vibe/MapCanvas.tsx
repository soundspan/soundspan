"use client";

/** Canvas renderer for the vibe map's filtered, highlighted dot sample. */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { resolveMapKeyNav } from "./mapKeyboardNav";
import type { Viewport } from "./mapViewport";
import { computeDotRadius, fitViewport } from "./mapViewport";
import type { MapTrack } from "./types";
import { getMoodColor, VIBE_ACCENTS } from "./types";

export interface MapCanvasProps {
    tracks: readonly MapTrack[];
    viewport: Viewport;
    width: number;
    height: number;
    mask: Uint8Array;
    positions?: Float32Array;
    highlightIds?: ReadonlySet<string> | null;
    dimUnhighlighted?: boolean;
    hoveredId?: string | null;
    className?: string;
    onSelectTrack?: (
        id: string,
        mods: { ctrlOrMeta: boolean; shift: boolean },
    ) => void;
    onPointerDown?: (event: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerMove?: (event: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerUp?: (event: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerCancel?: (event: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerLeave?: (event: React.PointerEvent<HTMLCanvasElement>) => void;
}

const TAU = Math.PI * 2;
const DIM_ALPHA = 0.05;
const BASE_ALPHA = 0.72;
const NONMATCH_ALPHA = 0.12;
const HOVER_BOOST = 2.5;
const GLOW_BOOST = 2.5;
const GLOW_RING_EXTRA = 3.5;
const CULL_MARGIN = 12;

type MapCanvasDrawProps = Pick<
    MapCanvasProps,
    | "tracks"
    | "viewport"
    | "width"
    | "height"
    | "mask"
    | "positions"
    | "highlightIds"
    | "dimUnhighlighted"
    | "hoveredId"
> & { focusedId: string | null };

function prepareCanvas(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
): CanvasRenderingContext2D | null {
    const dpr =
        typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    return context;
}

function paintFocusRing(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
): void {
    context.beginPath();
    context.arc(x, y, radius + GLOW_RING_EXTRA, 0, TAU);
    context.strokeStyle = VIBE_ACCENTS.trail;
    context.lineWidth = 2;
    context.globalAlpha = 1;
    context.stroke();
}

function paintDots(
    context: CanvasRenderingContext2D,
    props: MapCanvasDrawProps,
): void {
    const { tracks, viewport, width, height, mask, positions } = props;
    const highlights = props.highlightIds;
    const hasHighlight = !!highlights && highlights.size > 0;
    const hasPositions = !!positions && positions.length >= tracks.length * 2;
    const radius = computeDotRadius(
        viewport.scale,
        fitViewport({ width, height }).scale,
    );
    const { scale, tx, ty } = viewport;
    for (let index = 0; index < tracks.length; index++) {
        const track = tracks[index];
        const sx =
            (hasPositions ? positions![index * 2] : track.x) * scale + tx;
        const sy =
            (hasPositions ? positions![index * 2 + 1] : track.y) * scale + ty;
        if (
            sx < -CULL_MARGIN ||
            sx > width + CULL_MARGIN ||
            sy < -CULL_MARGIN ||
            sy > height + CULL_MARGIN
        )
            continue;
        const visible = mask[index] !== 0;
        const match = hasHighlight && highlights!.has(track.id);
        const hovered = visible && props.hoveredId === track.id;
        let dotRadius = radius;
        let alpha = BASE_ALPHA;
        if (!visible) alpha = DIM_ALPHA;
        else if (hovered) {
            dotRadius += HOVER_BOOST;
            alpha = 1;
        } else if (match) {
            dotRadius += GLOW_BOOST;
            alpha = 1;
        } else if (hasHighlight && props.dimUnhighlighted)
            alpha = NONMATCH_ALPHA;
        const color = getMoodColor(track.dominantMood);
        if (visible && match) {
            context.beginPath();
            context.arc(sx, sy, dotRadius + GLOW_RING_EXTRA, 0, TAU);
            context.fillStyle = color;
            context.globalAlpha = 0.22;
            context.fill();
        }
        context.beginPath();
        context.arc(sx, sy, dotRadius, 0, TAU);
        context.fillStyle = color;
        context.globalAlpha = alpha;
        context.fill();
        if (visible && props.focusedId === track.id)
            paintFocusRing(context, sx, sy, dotRadius);
    }
    context.globalAlpha = 1;
}

function drawCanvas(
    canvas: HTMLCanvasElement | null,
    props: MapCanvasDrawProps,
): void {
    if (!canvas || props.width <= 0 || props.height <= 0) return;
    const context = prepareCanvas(canvas, props.width, props.height);
    if (context) paintDots(context, props);
}

function navigableOrder(tracks: readonly MapTrack[], mask: Uint8Array) {
    return tracks.flatMap((_, index) => (mask[index] !== 0 ? [index] : []));
}

function handleCanvasKeyDown(
    event: React.KeyboardEvent<HTMLCanvasElement>,
    props: MapCanvasProps,
    order: readonly number[],
    focusedIndex: number | null,
    setFocusedIndex: React.Dispatch<React.SetStateAction<number | null>>,
): void {
    const result = resolveMapKeyNav(event.key, { order, focusedIndex });
    if (result.type === "none") return;
    event.preventDefault();
    if (result.type === "move") {
        setFocusedIndex(result.index);
        return;
    }
    props.onSelectTrack?.(props.tracks[result.index].id, {
        ctrlOrMeta: event.ctrlKey || event.metaKey,
        shift: event.shiftKey,
    });
}

function useCanvasDrawing(
    canvasRef: React.RefObject<HTMLCanvasElement | null>,
    props: MapCanvasDrawProps,
): void {
    const { tracks, viewport, width, height, mask, positions } = props;
    const { highlightIds, dimUnhighlighted, hoveredId, focusedId } = props;
    useEffect(() => {
        drawCanvas(canvasRef.current, {
            tracks,
            viewport,
            width,
            height,
            mask,
            positions,
            highlightIds,
            dimUnhighlighted,
            hoveredId,
            focusedId,
        });
    }, [
        canvasRef,
        tracks,
        viewport,
        width,
        height,
        mask,
        positions,
        highlightIds,
        dimUnhighlighted,
        hoveredId,
        focusedId,
    ]);
}

export function MapCanvas(props: MapCanvasProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const baseId = useId();
    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
    const { tracks, viewport, width, height, mask, positions } = props;
    const { highlightIds, dimUnhighlighted, hoveredId } = props;
    const order = useMemo(() => navigableOrder(tracks, mask), [tracks, mask]);
    const focusedId = tracks[focusedIndex ?? -1]?.id ?? null;
    const summaryId = `${baseId}-summary`;
    const summary = `Vibe map, ${tracks.length} tracks, ${order.length} shown. Use arrow keys to move between tracks and Enter to explore.`;
    const focusedTrack = tracks[focusedIndex ?? -1];
    const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) =>
        handleCanvasKeyDown(event, props, order, focusedIndex, setFocusedIndex);
    useCanvasDrawing(canvasRef, {
        tracks,
        viewport,
        width,
        height,
        mask,
        positions,
        highlightIds,
        dimUnhighlighted,
        hoveredId,
        focusedId,
    });
    return (
        <>
            <canvas
                ref={canvasRef}
                className={props.className ?? "absolute inset-0 touch-none"}
                role="application"
                aria-roledescription="Vibe map"
                aria-label={summary}
                aria-describedby={summaryId}
                tabIndex={0}
                onKeyDown={handleKeyDown}
                onPointerDown={props.onPointerDown}
                onPointerMove={props.onPointerMove}
                onPointerUp={props.onPointerUp}
                onPointerCancel={props.onPointerCancel}
                onPointerLeave={props.onPointerLeave}
            />
            <span id={summaryId} className="sr-only" aria-live="polite">
                {focusedTrack
                    ? `Focused: ${focusedTrack.title} by ${focusedTrack.artist}.`
                    : summary}
            </span>
        </>
    );
}
