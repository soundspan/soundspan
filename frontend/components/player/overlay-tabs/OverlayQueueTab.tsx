"use client";

import { memo, useEffect, useRef } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ListMusic, Trash2 } from "lucide-react";
import { isEpisodeQueueItem, type QueueItem } from "@/lib/queue-item";
import {
    resolveQueueCenteringBehavior,
    resolveQueueCenteringIndex,
} from "@/lib/overlay-queue-centering";
import { buildTabTransitionProps } from "./overlayTabMotion";
import {
    OverlayQueueEpisodeRow,
    OverlayQueueTrackRow,
} from "./OverlayQueueRows";

/**
 * Rows rendered on the first pass before react-virtuoso measures the
 * viewport; keeps happy-dom component tests and first paint windowed.
 */
const INITIAL_WINDOW_COUNT = 20;
const ESTIMATED_ROW_HEIGHT = 60;

interface OverlayQueueTabProps {
    queueTracks: QueueItem[];
    currentIndex: number;
    onPlayFromQueue: (index: number) => void;
    onRemoveFromQueue: (index: number) => void;
    onClearQueue: () => void;
}

/**
 * The overlay drawer's Up Next tab (GH #787): windowed queue list that
 * keeps the playing row centered. Mounts only while the tab is visible, so
 * a mount is a "reveal" and later index changes glide via scrollToIndex.
 */
export const OverlayQueueTab = memo(function OverlayQueueTab({
    queueTracks,
    currentIndex,
    onPlayFromQueue,
    onRemoveFromQueue,
    onClearQueue,
}: OverlayQueueTabProps) {
    const shouldReduceMotion = useReducedMotion();
    const virtuosoRef = useRef<VirtuosoHandle | null>(null);
    const isFirstRevealRef = useRef(true);
    const previousIndexRef = useRef<number | null>(null);

    useEffect(() => {
        const isFirstReveal = isFirstRevealRef.current;
        const indexChanged =
            previousIndexRef.current !== null &&
            previousIndexRef.current !== currentIndex;
        isFirstRevealRef.current = false;
        previousIndexRef.current = currentIndex;

        const behavior = resolveQueueCenteringBehavior({
            isFirstReveal,
            indexChanged,
            shouldReduceMotion: !!shouldReduceMotion,
            queueLength: queueTracks.length,
        });
        // The reveal itself is handled by initialTopMostItemIndex below.
        if (!behavior || isFirstReveal) return;
        virtuosoRef.current?.scrollToIndex({
            index: resolveQueueCenteringIndex(currentIndex, queueTracks.length),
            align: "center",
            behavior,
        });
    }, [currentIndex, queueTracks.length, shouldReduceMotion]);

    return (
        <motion.section
            key="queue"
            {...buildTabTransitionProps(shouldReduceMotion)}
            className="h-full overflow-hidden flex flex-col"
        >
            <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-2">
                <div className="flex items-center gap-2">
                    <ListMusic className="h-4 w-4 text-brand-hover" />
                    <h2 className="text-sm font-semibold text-white">
                        Up Next
                    </h2>
                </div>
                <div className="flex items-center gap-3">
                    {queueTracks.length > 0 && (
                        <button
                            type="button"
                            onClick={onClearQueue}
                            className="inline-flex items-center gap-1 text-xs text-gray-400 transition-colors hover:text-white"
                            title="Clear queue"
                            aria-label="Clear queue"
                        >
                            <Trash2 className="h-3 w-3" />
                            Clear Queue
                        </button>
                    )}
                    <span className="text-xs text-gray-400">
                        {queueTracks.length} items
                    </span>
                </div>
            </div>

            {queueTracks.length === 0 ? (
                <div className="flex min-h-0 flex-1 items-center justify-center px-4">
                    <p className="text-sm text-gray-400">No tracks in queue.</p>
                </div>
            ) : (
                <div className="min-h-0 flex-1 px-2 py-2">
                    <Virtuoso
                        ref={virtuosoRef}
                        style={{ height: "100%" }}
                        totalCount={queueTracks.length}
                        initialItemCount={Math.min(
                            queueTracks.length,
                            INITIAL_WINDOW_COUNT,
                        )}
                        initialTopMostItemIndex={{
                            index: resolveQueueCenteringIndex(
                                currentIndex,
                                queueTracks.length,
                            ),
                            align: "center",
                        }}
                        defaultItemHeight={ESTIMATED_ROW_HEIGHT}
                        computeItemKey={(index) => {
                            const item = queueTracks[index];
                            return item ? `${item.id}-${index}` : index;
                        }}
                        itemContent={(queueIndex) => {
                            const item = queueTracks[queueIndex];
                            if (!item) return null;
                            const rowProps = {
                                queueIndex,
                                isCurrentTrack: queueIndex === currentIndex,
                                isPlayedTrack: queueIndex < currentIndex,
                                onPlayFromQueue,
                                onRemoveFromQueue,
                            };
                            return isEpisodeQueueItem(item) ? (
                                <OverlayQueueEpisodeRow
                                    item={item}
                                    {...rowProps}
                                />
                            ) : (
                                <OverlayQueueTrackRow
                                    track={item}
                                    {...rowProps}
                                />
                            );
                        }}
                    />
                </div>
            )}
        </motion.section>
    );
});
