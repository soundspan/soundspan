import type { ReactNode } from "react";
import type { Track } from "@/lib/audio-state-context";

/**
 * Minimal display contract for a single track row.
 * Each surface provides a `toRowItem()` adapter mapping its domain type to this shape.
 */
export interface TrackRowItem {
    id: string;
    title: string;
    displayTitle?: string | null;
    artistName: string;
    duration: number;
    /** Fully-resolved cover art URL. Null = placeholder. */
    coverArtUrl: string | null;
}

/**
 * Composition slots injected per-surface to customize row rendering.
 */
export interface TrackRowSlots {
    /** Replace the default track number column. */
    leadingColumn?: ReactNode;
    /** Inline badges after title text. */
    titleBadges?: ReactNode;
    /** Replace the default plain-text artist line (e.g. with a linked version).
     *  `undefined` → show default artist name.  `null` → hide artist line entirely. */
    artistContent?: ReactNode;
    /** Content below artist (provider badges, timestamps, error messages). */
    subtitleExtra?: ReactNode;
    /** Extra grid columns between title block and trailing actions. */
    middleColumns?: ReactNode;
    /** Replace entire trailing actions area (duration + preference + overflow). */
    trailingActions?: ReactNode;
    /** Additional className merged onto the row div. */
    rowClassName?: string;
}

/**
 * Configuration for the TrackOverflowMenu rendered by TrackRow.
 */
export interface OverflowConfig {
    track: Track;
    showGoToArtist?: boolean;
    showGoToAlbum?: boolean;
    showMatchVibe?: boolean;
    showStartRadio?: boolean;
    showPlayNext?: boolean;
    showAddToQueue?: boolean;
    showAddToPlaylist?: boolean;
    extraItemsBefore?: ReactNode;
    extraItemsAfter?: ReactNode;
}

/**
 * Props for a single TrackRow component.
 */
export interface TrackRowProps {
    item: TrackRowItem;
    index: number;
    isPlaying?: boolean;
    isInQueue?: boolean;
    onPlay?: () => void;
    /** Grid template className. */
    className?: string;
    /** Playing state accent color. Default: "#3b82f6". */
    accentColor?: string;
    /** Show cover art. Default: true. */
    showCoverArt?: boolean;
    /** TrackPreferenceButtons mode. Null = hide. */
    preferenceMode?: "both" | "up-only" | null;
    /** Overflow menu config. Null = hide. */
    overflowProps?: OverflowConfig | null;
    /** Composition slots. */
    slots?: TrackRowSlots;
}

/**
 * Internal row state passed to slot factory functions.
 */
export interface RowState {
    isPlaying: boolean;
    isInQueue: boolean;
}

/**
 * Props for the generic TrackList wrapper component.
 */
export interface TrackListProps<T> {
    items: T[];
    toRowItem: (item: T, index: number) => TrackRowItem;
    onPlay: (item: T, index: number) => void;
    /** Custom key extractor. Defaults to rowItem.id. Use when items may share the same track ID (e.g. playlist duplicates). */
    getKey?: (item: T, index: number) => string;
    rowSlots?: (item: T, index: number, state: RowState) => TrackRowSlots | undefined;
    rowOverflow?: (item: T, index: number, state: RowState) => OverflowConfig | null;
    rowClassName?: string;
    header?: ReactNode;
    separator?: (item: T, index: number, prevItem: T | null) => ReactNode | null;
    accentColor?: string;
    showCoverArt?: boolean;
    preferenceMode?: "both" | "up-only" | null;
    tvSection?: string;
    className?: string;
    emptyState?: ReactNode;
    loadingState?: ReactNode;
    isLoading?: boolean;
    /** When true, render items using react-virtuoso for large lists. Default: false. */
    virtualized?: boolean;
    /** Estimated row height in px when virtualized. Default: 64. */
    estimatedItemHeight?: number;
}

/**
 * Props for the TrackListHeader component.
 */
export interface TrackListHeaderProps {
    columns: Array<{ label: string; className?: string }>;
    /** Grid template className that matches the rows. */
    className?: string;
}
