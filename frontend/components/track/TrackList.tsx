"use client";

import { useCallback } from "react";
import { Virtuoso } from "react-virtuoso";
import { useAudioState } from "@/lib/audio-state-context";
import { useQueuedTrackIds } from "@/hooks/useQueuedTrackIds";
import { TrackRow } from "./TrackRow";
import type { TrackListProps } from "./types";

/**
 * Renders the TrackList component.
 *
 * Generic list wrapper that owns useAudioState/useQueuedTrackIds so individual
 * surfaces never import those hooks for track rendering. Generic `<T>` preserves
 * domain types; `onPlay`, `rowSlots`, and `rowOverflow` receive the original `T`.
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
}: TrackListProps<T>) {
    const { currentTrack } = useAudioState();
    const queuedTrackIds = useQueuedTrackIds();
    const currentTrackId = currentTrack?.id;

    const handlePlay = useCallback(
        (item: T, index: number) => () => onPlay(item, index),
        [onPlay],
    );

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

        return (
            <div key={key}>
                {sep}
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
