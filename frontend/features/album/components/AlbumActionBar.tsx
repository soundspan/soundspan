import { useState } from "react";
import {
    Play,
    Pause,
    Shuffle,
    Download,
    ListMusic,
    Plus,
    Share2,
    Loader2,
    Search,
    Heart,
    Check,
    Send,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/utils/cn";
import type { ColorPalette } from "@/hooks/useImageColor";
import { usePlayButtonFeedback } from "@/hooks/usePlayButtonFeedback";
import { ReleaseSelectionModal } from "@/components/ui/ReleaseSelectionModal";
import { ShareLinkModal } from "@/components/ui/ShareLinkModal";
import type { Album, AlbumSource } from "../types";
import {
    getAlbumActionVisibility,
    type AlbumActionVisibility,
} from "../albumActionVisibility";

const BRAND_PLAY = "#60a5fa";
const LOCK_MESSAGE =
    "Listen Together is active — use Add to Queue to add tracks to the shared session.";

interface AlbumActionBarProps {
    album: Album;
    source: AlbumSource;
    colors: ColorPalette | null;
    onPlayAll: () => void;
    onAddAllToQueue?: () => void;
    onShuffle: () => void;
    onDownloadAlbum: () => void;
    onAddToPlaylist: () => void;
    onToggleAlbumLike?: () => void;
    isAlbumLiked?: boolean;
    isPendingDownload: boolean;
    isApplyingAlbumPreference?: boolean;
    isPlaying?: boolean;
    isPlayingThisAlbum?: boolean;
    onPause?: () => void;
    downloadsEnabled?: boolean;
    requestsEnabled?: boolean;
    isRequestedAlbum?: boolean;
    isSubmittingRequest?: boolean;
    onRequestAlbum?: () => void;
    isInListenTogetherGroup?: boolean;
}

interface PlaybackControlsProps {
    showPause: boolean;
    showSpinner: boolean;
    onPlayPause: () => void;
    onShuffle: () => void;
    onShare: () => void;
    canShare: boolean;
}

function PlaybackControls(props: PlaybackControlsProps) {
    return (
        <>
            <button
                type="button"
                onClick={props.onPlayPause}
                className="flex items-center gap-2 px-5 py-2.5 rounded-full shadow-lg font-semibold text-sm text-black transition-all hover:scale-105"
                style={{ backgroundColor: BRAND_PLAY }}
            >
                {props.showSpinner ? (
                    <Loader2 className="w-5 h-5 animate-spin text-black" />
                ) : props.showPause ? (
                    <Pause className="w-5 h-5 fill-current text-black" />
                ) : (
                    <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                )}
                <span>{props.showPause ? "Pause" : "Play All"}</span>
            </button>
            <button
                type="button"
                onClick={props.onShuffle}
                className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                title="Shuffle play"
            >
                <Shuffle className="w-5 h-5" />
            </button>
            {props.canShare && (
                <button
                    type="button"
                    onClick={props.onShare}
                    className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                    title="Share album"
                >
                    <Share2 className="w-5 h-5" />
                </button>
            )}
        </>
    );
}

interface AcquisitionControlsProps {
    pending: boolean;
    onDownload: () => void;
    onSearch: () => void;
}

function AcquisitionControls(props: AcquisitionControlsProps) {
    const enabledClass =
        "bg-brand-hover hover:bg-brand text-black hover:scale-105";
    const pendingClass = "bg-white/5 text-white/50 cursor-not-allowed";
    return (
        <div className="flex items-center gap-2">
            <button
                type="button"
                onClick={props.onDownload}
                disabled={props.pending}
                className={cn(
                    "flex items-center gap-2 px-5 py-2.5 rounded-full font-medium transition-all",
                    props.pending ? pendingClass : enabledClass,
                )}
                title="Auto-download best release"
            >
                <Download className="w-4 h-4" />
                <span>{props.pending ? "Downloading..." : "Download"}</span>
            </button>
            <button
                type="button"
                onClick={props.onSearch}
                disabled={props.pending}
                className={cn(
                    "flex items-center gap-2 px-4 py-2.5 rounded-full font-medium transition-all",
                    props.pending ? pendingClass : enabledClass,
                )}
                title="Search and select a specific release"
            >
                <Search className="w-4 h-4" />
                <span>Search</span>
            </button>
        </div>
    );
}

interface RequestControlsProps {
    requested: boolean;
    submitting: boolean;
    onRequest: () => void;
}

function RequestControls(props: RequestControlsProps) {
    if (props.requested) {
        return (
            <button
                type="button"
                disabled
                className="flex items-center gap-2 px-5 py-2.5 rounded-full font-medium bg-white/5 text-white/50 cursor-not-allowed"
                title="You already have an open request for this album"
            >
                <Check className="w-4 h-4" />
                <span>Requested</span>
            </button>
        );
    }
    return (
        <button
            type="button"
            onClick={props.onRequest}
            disabled={props.submitting}
            className={cn(
                "flex items-center gap-2 px-5 py-2.5 rounded-full font-medium transition-all",
                props.submitting
                    ? "bg-white/5 text-white/50 cursor-not-allowed"
                    : "bg-brand-hover hover:bg-brand text-black hover:scale-105",
            )}
            title="Ask an admin to add this album to the library"
        >
            {props.submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
                <Send className="w-4 h-4" />
            )}
            <span>{props.submitting ? "Requesting..." : "Request"}</span>
        </button>
    );
}

function LockedPlaybackControls({ showPause }: { showPause: boolean }) {
    return (
        <>
            <button
                type="button"
                onClick={() => toast.error(LOCK_MESSAGE)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-full shadow-lg font-semibold text-sm border border-white/15 bg-white/10 text-white/40"
                title={LOCK_MESSAGE}
            >
                {showPause ? (
                    <Pause className="w-5 h-5 fill-current" />
                ) : (
                    <Play className="w-5 h-5 fill-current ml-0.5" />
                )}
                <span>{showPause ? "Pause" : "Play All"}</span>
            </button>
            <button
                type="button"
                onClick={() => toast.error(LOCK_MESSAGE)}
                className="h-8 w-8 rounded-full border border-white/15 bg-white/10 flex items-center justify-center text-white/40"
                title={LOCK_MESSAGE}
            >
                <Shuffle className="w-5 h-5" />
            </button>
        </>
    );
}

function LockedAcquisitionControls({ pending }: { pending: boolean }) {
    return (
        <>
            <button
                type="button"
                onClick={() => toast.error(LOCK_MESSAGE)}
                className={cn(
                    "flex items-center gap-2 px-5 py-2.5 rounded-full font-medium border border-white/15 bg-white/10 text-white/40",
                    pending && "opacity-70",
                )}
                title={LOCK_MESSAGE}
            >
                <Download className="w-4 h-4" />
                <span>{pending ? "Downloading..." : "Download"}</span>
            </button>
            <button
                type="button"
                onClick={() => toast.error(LOCK_MESSAGE)}
                className="flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2.5 font-medium text-white/40"
                title={LOCK_MESSAGE}
            >
                <Search className="w-4 h-4" />
                <span>Search</span>
            </button>
        </>
    );
}

function LockedControls(props: {
    visibility: AlbumActionVisibility;
    showPause: boolean;
    pending: boolean;
}) {
    return (
        <div className="inline-flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-2.5 py-1.5">
            {props.visibility.isLibraryVisible && (
                <LockedPlaybackControls showPause={props.showPause} />
            )}
            {props.visibility.showAcquisition && (
                <LockedAcquisitionControls pending={props.pending} />
            )}
        </div>
    );
}

function AlbumPreferenceButton(props: {
    liked: boolean;
    applying: boolean;
    onToggle: () => void;
}) {
    return (
        <button
            type="button"
            onClick={props.onToggle}
            disabled={props.applying}
            className={cn(
                "h-8 w-8 rounded-full flex items-center justify-center transition-colors",
                props.applying
                    ? "cursor-not-allowed text-white/35"
                    : props.liked
                      ? "text-brand hover:bg-white/10"
                      : "text-white/60 hover:bg-white/10 hover:text-white",
            )}
            title={
                props.liked
                    ? "Remove like from all tracks"
                    : "Like every track on this album"
            }
        >
            {props.applying ? (
                <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
                <Heart
                    className={cn("h-4 w-4", props.liked && "fill-current")}
                />
            )}
        </button>
    );
}

interface SecondaryControlsProps {
    visibility: AlbumActionVisibility;
    onAddAllToQueue?: () => void;
    onAddToPlaylist: () => void;
    onShare: () => void;
    onToggleAlbumLike?: () => void;
    liked: boolean;
    applying: boolean;
}

function SecondaryControls(props: SecondaryControlsProps) {
    return (
        <>
            {props.visibility.canShowAddAllToQueue && (
                <button
                    type="button"
                    onClick={props.onAddAllToQueue}
                    className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                    title="Add all to queue"
                >
                    <ListMusic className="w-5 h-5" />
                </button>
            )}
            {!props.visibility.isLibraryVisible &&
                props.visibility.canShareAlbum && (
                    <button
                        type="button"
                        onClick={props.onShare}
                        className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                        title="Share album"
                    >
                        <Share2 className="w-5 h-5" />
                    </button>
                )}
            {props.visibility.canShowAddToPlaylist && (
                <button
                    type="button"
                    onClick={props.onAddToPlaylist}
                    className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                    title="Add to playlist"
                >
                    <Plus className="w-5 h-5" />
                </button>
            )}
            {props.visibility.canShowAlbumPreference &&
                props.onToggleAlbumLike && (
                    <AlbumPreferenceButton
                        liked={props.liked}
                        applying={props.applying}
                        onToggle={props.onToggleAlbumLike}
                    />
                )}
        </>
    );
}

function AlbumActionModals(props: {
    album: Album;
    acquisitionMbid: string | null;
    showReleaseModal: boolean;
    closeReleaseModal: () => void;
    showShareModal: boolean;
    closeShareModal: () => void;
}) {
    return (
        <>
            {props.acquisitionMbid && (
                <ReleaseSelectionModal
                    isOpen={props.showReleaseModal}
                    onClose={props.closeReleaseModal}
                    albumMbid={props.acquisitionMbid}
                    artistName={props.album.artist?.name || "Unknown Artist"}
                    albumTitle={props.album.title}
                />
            )}
            <ShareLinkModal
                isOpen={props.showShareModal}
                onClose={props.closeShareModal}
                resourceType="album"
                resourceId={props.album.id}
                resourceName={props.album.title}
            />
        </>
    );
}

function ActionControlRow(props: {
    actions: AlbumActionBarProps;
    visibility: AlbumActionVisibility;
    showPause: boolean;
    showSpinner: boolean;
    onPlayPause: () => void;
    onShare: () => void;
    onSearch: () => void;
}) {
    const { actions, visibility } = props;
    if (!visibility.hasActionControls) return null;
    return (
        <div className="inline-flex w-fit max-w-full flex-wrap items-center gap-2 rounded-2xl border border-white/10 bg-black/25 px-2.5 py-2 backdrop-blur-sm">
            {actions.isInListenTogetherGroup && visibility.hasLockedControls ? (
                <LockedControls
                    visibility={visibility}
                    showPause={props.showPause}
                    pending={actions.isPendingDownload}
                />
            ) : (
                <>
                    {visibility.isLibraryVisible && (
                        <PlaybackControls
                            showPause={props.showPause}
                            showSpinner={props.showSpinner}
                            onPlayPause={props.onPlayPause}
                            onShuffle={actions.onShuffle}
                            onShare={props.onShare}
                            canShare={visibility.canShareAlbum}
                        />
                    )}
                    {visibility.showAcquisition && (
                        <AcquisitionControls
                            pending={actions.isPendingDownload}
                            onDownload={actions.onDownloadAlbum}
                            onSearch={props.onSearch}
                        />
                    )}
                    {visibility.showRequest && actions.onRequestAlbum && (
                        <RequestControls
                            requested={actions.isRequestedAlbum ?? false}
                            submitting={actions.isSubmittingRequest ?? false}
                            onRequest={actions.onRequestAlbum}
                        />
                    )}
                </>
            )}
            <SecondaryControls
                visibility={visibility}
                onAddAllToQueue={actions.onAddAllToQueue}
                onAddToPlaylist={actions.onAddToPlaylist}
                onShare={props.onShare}
                onToggleAlbumLike={actions.onToggleAlbumLike}
                liked={actions.isAlbumLiked ?? false}
                applying={actions.isApplyingAlbumPreference ?? false}
            />
        </div>
    );
}

/** Renders album actions from the pure visibility policy. */
export function AlbumActionBar(props: AlbumActionBarProps) {
    const [showReleaseModal, setShowReleaseModal] = useState(false);
    const [showShareModal, setShowShareModal] = useState(false);
    const showPause = Boolean(props.isPlaying && props.isPlayingThisAlbum);
    const visibility = getAlbumActionVisibility({
        source: props.source,
        owned: props.album.owned,
        albumId: props.album.id,
        rgMbid: props.album.rgMbid,
        mbid: props.album.mbid,
        downloadsEnabled: props.downloadsEnabled ?? true,
        requestsEnabled:
            (props.requestsEnabled ?? false) && Boolean(props.onRequestAlbum),
        hasAddAllToQueue: Boolean(props.onAddAllToQueue),
        hasAlbumPreferenceAction: Boolean(props.onToggleAlbumLike),
        isInListenTogetherGroup: props.isInListenTogetherGroup ?? false,
    });
    const { showSpinner, trigger } = usePlayButtonFeedback();
    const playPause = () => {
        trigger();
        if (showPause && props.onPause) props.onPause();
        else props.onPlayAll();
    };
    const openShare = () => setShowShareModal(true);

    return (
        <div className="space-y-2">
            <ActionControlRow
                actions={props}
                visibility={visibility}
                showPause={showPause}
                showSpinner={showSpinner}
                onPlayPause={playPause}
                onShare={openShare}
                onSearch={() => setShowReleaseModal(true)}
            />
            {props.isInListenTogetherGroup && visibility.hasLockedControls && (
                <p className="text-xs text-white/40">{LOCK_MESSAGE}</p>
            )}
            <AlbumActionModals
                album={props.album}
                acquisitionMbid={
                    visibility.showAcquisition
                        ? visibility.acquisitionMbid
                        : null
                }
                showReleaseModal={showReleaseModal}
                closeReleaseModal={() => setShowReleaseModal(false)}
                showShareModal={showShareModal}
                closeShareModal={() => setShowShareModal(false)}
            />
        </div>
    );
}
