"use client";

/** Queue panel for current and upcoming mixed-media items on the vibe map. */

import { useCallback, useRef, useState } from "react";
import { GripVertical, Music, X } from "lucide-react";
import { resolveDropPosition, resolveDropTargetIndex, type DropPosition } from
    "@/components/track/reorderDnd";
import { isEpisodeQueueItem, type QueueItem } from "@/lib/queue-item";
import { VIBE_PANEL_CLASS, VIBE_PANEL_STYLE, PANEL_CLOSE_CLASS } from "./TravelPanel";

export interface QueuePanelProps {
    queue: QueueItem[];
    currentIndex: number;
    onClose: () => void;
    onReorder: (fromIndex: number, toIndex: number) => void;
    onRemove?: (index: number) => void;
    reorderDisabled?: boolean;
}

function queueItemTitle(item: QueueItem): string {
    return isEpisodeQueueItem(item) ? item.title : (item.displayTitle ?? item.title);
}

function queueItemSubtitle(item: QueueItem): string {
    return isEpisodeQueueItem(item) ? item.podcastTitle : (item.artist?.name ?? "");
}

/** Translate upcoming-row drop indices into absolute queue indices. */
export function resolveQueueDropIndices(
    currentIndex: number,
    fromIdx: number,
    overIdx: number,
    position: DropPosition
): { from: number; to: number } {
    const toIdx = resolveDropTargetIndex(fromIdx, overIdx, position);
    return { from: currentIndex + 1 + fromIdx, to: currentIndex + 1 + toIdx };
}

interface QueueDrag {
    from: number | null;
    over: { idx: number; position: DropPosition } | null;
    start: (idx: number, event: React.DragEvent<HTMLButtonElement>) => void;
    moveOver: (idx: number, event: React.DragEvent<HTMLLIElement>) => void;
    leave: (idx: number, event: React.DragEvent<HTMLLIElement>) => void;
    drop: (idx: number, event: React.DragEvent<HTMLLIElement>) => void;
    clear: () => void;
}

function useQueueDrag(currentIndex: number, reorder: QueuePanelProps["onReorder"]): QueueDrag {
    const fromRef = useRef<number | null>(null);
    const [from, setFrom] = useState<number | null>(null);
    const [over, setOver] = useState<QueueDrag["over"]>(null);
    const clear = useCallback(() => {
        fromRef.current = null;
        setFrom(null);
        setOver(null);
    }, []);
    const start = useCallback((idx: number, event: React.DragEvent<HTMLButtonElement>) => {
        fromRef.current = idx;
        setFrom(idx);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(idx));
    }, []);
    const moveOver = useCallback((idx: number, event: React.DragEvent<HTMLLIElement>) => {
        if (fromRef.current === null) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const rect = event.currentTarget.getBoundingClientRect();
        setOver({ idx, position: resolveDropPosition(event.clientY - rect.top, rect.height) });
    }, []);
    const leave = useCallback((idx: number, event: React.DragEvent<HTMLLIElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setOver((value) => value?.idx === idx ? null : value);
    }, []);
    const drop = useCallback((idx: number, event: React.DragEvent<HTMLLIElement>) => {
        const fromIdx = fromRef.current;
        if (fromIdx === null) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        const position = resolveDropPosition(event.clientY - rect.top, rect.height);
        const indices = resolveQueueDropIndices(currentIndex, fromIdx, idx, position);
        clear();
        if (indices.to !== indices.from) reorder(indices.from, indices.to);
    }, [currentIndex, clear, reorder]);
    return { from, over, start, moveOver, leave, drop, clear };
}

function QueueHeader({ close }: { close: () => void }) {
    return (
        <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-semibold text-white">Queue</span>
            <button type="button" onClick={close} aria-label="Close queue"
                title="Close queue (Esc)" className={PANEL_CLOSE_CLASS}>
                <X className="w-4 h-4" />
            </button>
        </div>
    );
}

function CurrentQueueItem({ item }: { item: QueueItem | null }) {
    if (!item) return null;
    return (
        <div className="flex items-center gap-2 px-2 py-1.5 mb-1.5 rounded-lg bg-indigo-500/10 border border-indigo-400/20">
            <Music className="w-3.5 h-3.5 text-indigo-300 shrink-0" />
            <span className="flex-1 min-w-0">
                <span className="block truncate text-[13px] text-white">{queueItemTitle(item)}</span>
                <span className="block truncate text-xs text-gray-400">{queueItemSubtitle(item)}</span>
            </span>
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-indigo-300">Now playing</span>
        </div>
    );
}

function QueueRow({ item, idx, absoluteIndex, drag, remove, disabled }: {
    item: QueueItem;
    idx: number;
    absoluteIndex: number;
    drag: QueueDrag;
    remove?: (index: number) => void;
    disabled?: boolean;
}) {
    const title = queueItemTitle(item);
    const marker = drag.over?.idx === idx && drag.from !== idx ? drag.over.position : null;
    return (
        <li className={drag.from === idx ? "relative opacity-50" : "relative"}
            onDragOver={(event) => drag.moveOver(idx, event)}
            onDragLeave={(event) => drag.leave(idx, event)}
            onDrop={(event) => drag.drop(idx, event)}>
            {marker && <div className={`pointer-events-none absolute left-0 right-0 h-0.5 rounded bg-indigo-400 z-10 ${marker === "before" ? "top-0" : "bottom-0"}`} />}
            <div className="group flex items-center gap-1.5 px-1 py-1.5 rounded-lg hover:bg-white/5">
                {!disabled && (
                    <button type="button" draggable onClick={(event) => event.stopPropagation()}
                        onDragStart={(event) => drag.start(idx, event)} onDragEnd={drag.clear}
                        aria-label={`Drag to reorder ${title}`} title="Drag to reorder"
                        className="shrink-0 w-6 h-6 grid place-items-center rounded text-gray-400 hover:text-white cursor-grab active:cursor-grabbing">
                        <GripVertical className="w-4 h-4" />
                    </button>
                )}
                <span className="flex-1 min-w-0">
                    <span className="block truncate text-[13px] text-white">{title}</span>
                    <span className="block truncate text-xs text-gray-400">{queueItemSubtitle(item)}</span>
                </span>
                {remove && (
                    <button type="button" onClick={() => remove(absoluteIndex)}
                        aria-label={`Remove ${title} from queue`} title="Remove from queue"
                        className="shrink-0 w-7 h-7 grid place-items-center rounded-lg text-gray-400 hover:text-red-400 hover:bg-white/10 transition-colors">
                        <X className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>
        </li>
    );
}

function UpcomingQueue({ items, currentIndex, drag, remove, disabled }: {
    items: QueueItem[];
    currentIndex: number;
    drag: QueueDrag;
    remove?: (index: number) => void;
    disabled?: boolean;
}) {
    if (items.length === 0) {
        return <p className="text-xs text-gray-400 py-2">Nothing queued — sweep some dots or play a journey.</p>;
    }
    return (
        <ul className="flex flex-col">
            {items.map((item, idx) => (
                <QueueRow key={`${item.id}-${currentIndex + 1 + idx}`} item={item}
                    idx={idx} absoluteIndex={currentIndex + 1 + idx} drag={drag}
                    remove={remove} disabled={disabled} />
            ))}
        </ul>
    );
}

export function QueuePanel(props: QueuePanelProps) {
    const current = props.queue[props.currentIndex] ?? null;
    const upcoming = props.queue.slice(props.currentIndex + 1);
    const drag = useQueueDrag(props.currentIndex, props.onReorder);
    return (
        <div className={VIBE_PANEL_CLASS} style={VIBE_PANEL_STYLE} data-vibe-panel="queue">
            <QueueHeader close={props.onClose} />
            <CurrentQueueItem item={current} />
            <UpcomingQueue items={upcoming} currentIndex={props.currentIndex}
                drag={drag} remove={props.onRemove} disabled={props.reorderDisabled} />
        </div>
    );
}
