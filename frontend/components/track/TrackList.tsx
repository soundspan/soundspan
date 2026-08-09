"use client";

import { useCallback, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { GripVertical } from "lucide-react";
import { cn } from "@/utils/cn";
import { useAudioState } from "@/lib/audio-state-context";
import { useQueuedTrackIds } from "@/hooks/useQueuedTrackIds";
import { TrackRow } from "./TrackRow";
import {
    resolveDropPosition,
    resolveDropTargetIndex,
    resolveKeyboardReorderTarget,
    type DropPosition,
} from "./reorderDnd";
import type { TrackListProps } from "./types";

interface DragOverState {
    index: number;
    position: DropPosition;
}

/**
 * Renders the TrackList component.
 *
 * Generic list wrapper that owns useAudioState/useQueuedTrackIds so individual
 * surfaces never import those hooks for track rendering. Generic `<T>` preserves
 * domain types; `onPlay`, `rowSlots`, and `rowOverflow` receive the original `T`.
 *
 * With the optional `reorder` prop (non-virtualized lists only), each row
 * gains a hover-revealed grip handle in its left padding gutter for pointer
 * and keyboard reordering (GH #27); all decision math lives in the pure
 * reorderDnd module. Without the prop the render output is unchanged.
 */
export function TrackList<T>({
    items,
    toRowItem,
    onPlay,
    getKey,
    rowSlots,
    rowOverflow,
    rowClassName,
    header,
    separator,
    accentColor,
    showCoverArt,
    preferenceMode,
    tvSection,
    className,
    emptyState,
    loadingState,
    isLoading,
    virtualized,
    estimatedItemHeight = 64,
    reorder,
}: TrackListProps<T>) {
    const { currentTrack } = useAudioState();
    const queuedTrackIds = useQueuedTrackIds();
    const currentTrackId = currentTrack?.id;

    const dragIndexRef = useRef<number | null>(null);
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dragOver, setDragOver] = useState<DragOverState | null>(null);
    const reorderEnabled = Boolean(reorder) && !virtualized;

    const handlePlay = useCallback(
        (item: T, index: number) => () => onPlay(item, index),
        [onPlay],
    );

    const clearDragState = useCallback(() => {
        dragIndexRef.current = null;
        setDragIndex(null);
        setDragOver(null);
    }, []);

    if (isLoading && loadingState) {
        return <>{loadingState}</>;
    }

    if (!isLoading && items.length === 0 && emptyState) {
        return <>{emptyState}</>;
    }

    const renderRow = (index: number) => {
        const item = items[index];
        const rowItem = toRowItem(item, index);
        const key = getKey ? getKey(item, index) : rowItem.id;
        const isPlaying = currentTrackId === rowItem.id;
        const isInQueue = queuedTrackIds.has(rowItem.id);
        const state = { isPlaying, isInQueue };

        const slots = rowSlots?.(item, index, state);
        const overflow = rowOverflow?.(item, index, state);
        const sep = separator?.(item, index, index > 0 ? items[index - 1] : null);

        const row = (
            <TrackRow
                item={rowItem}
                index={index}
                isPlaying={isPlaying}
                isInQueue={isInQueue}
                onPlay={handlePlay(item, index)}
                className={rowClassName}
                accentColor={accentColor}
                showCoverArt={showCoverArt}
                preferenceMode={preferenceMode}
                overflowProps={overflow}
                slots={slots}
            />
        );

        if (!reorderEnabled) {
            return (
                <div key={key}>
                    {sep}
                    {row}
                </div>
            );
        }

        const isDropTarget = dragOver?.index === index;
        return (
            <div key={key}>
                {sep}
                <div
                    role="group"
                    className={cn(
                        "relative group/reorder",
                        dragIndex === index && "opacity-50",
                    )}
                    onDragOver={(e) => {
                        if (dragIndexRef.current === null) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        const rect = e.currentTarget.getBoundingClientRect();
                        setDragOver({
                            index,
                            position: resolveDropPosition(
                                e.clientY - rect.top,
                                rect.height,
                            ),
                        });
                    }}
                    onDragLeave={(e) => {
                        if (e.currentTarget.contains(e.relatedTarget as Node)) {
                            return;
                        }
                        setDragOver((current) =>
                            current?.index === index ? null : current,
                        );
                    }}
                    onDrop={(e) => {
                        const fromIndex = dragIndexRef.current;
                        if (fromIndex === null) return;
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        const toIndex = resolveDropTargetIndex(
                            fromIndex,
                            index,
                            resolveDropPosition(
                                e.clientY - rect.top,
                                rect.height,
                            ),
                        );
                        clearDragState();
                        if (toIndex !== fromIndex) {
                            reorder?.onReorder(fromIndex, toIndex);
                        }
                    }}
                >
                    {/* Drop indicator line */}
                    {isDropTarget && dragIndex !== index && (
                        <div
                            className={cn(
                                "pointer-events-none absolute left-0 right-0 h-0.5 rounded bg-blue-400 z-10",
                                dragOver?.position === "before"
                                    ? "top-0"
                                    : "bottom-0",
                            )}
                        />
                    )}
                    {/* Hover-revealed reorder handle in the row's left padding
                        gutter. Pointer dragging is hidden on touch-first
                        breakpoints where menu actions cover reordering. */}
                    <button
                        type="button"
                        draggable
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                            const target = resolveKeyboardReorderTarget(
                                e.key,
                                index,
                                items.length,
                            );
                            if (target === null) return;
                            e.preventDefault();
                            reorder?.onReorder(index, target);
                        }}
                        onDragStart={(e) => {
                            dragIndexRef.current = index;
                            setDragIndex(index);
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", String(index));
                            const rowElement =
                                e.currentTarget.parentElement;
                            if (rowElement) {
                                e.dataTransfer.setDragImage(
                                    rowElement,
                                    16,
                                    rowElement.clientHeight / 2,
                                );
                            }
                        }}
                        onDragEnd={clearDragState}
                        title="Drag to reorder"
                        aria-label={`Reorder ${rowItem.title}, use arrow keys to move`}
                        className={cn(
                            "absolute left-0 top-0 bottom-0 z-10 hidden md:flex w-4 cursor-grab touch-none",
                            "items-center justify-center text-gray-500 hover:text-white",
                            "opacity-0 group-hover/reorder:opacity-100 focus:opacity-100 transition-opacity",
                            dragIndex === index && "cursor-grabbing",
                        )}
                    >
                        <GripVertical className="h-4 w-4" />
                    </button>
                    {row}
                </div>
            </div>
        );
    };

    if (virtualized) {
        return (
            <>
                {header}
                <div data-tv-section={tvSection} className={className}>
                    <Virtuoso
                        totalCount={items.length}
                        initialItemCount={items.length}
                        defaultItemHeight={estimatedItemHeight}
                        itemContent={renderRow}
                        style={{ height: Math.min(items.length * estimatedItemHeight, 600) }}
                    />
                </div>
            </>
        );
    }

    return (
        <>
            {header}
            <div data-tv-section={tvSection} className={className}>
                {items.map((_, index) => renderRow(index))}
            </div>
        </>
    );
}
