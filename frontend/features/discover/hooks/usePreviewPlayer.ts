import {
    useState,
    useCallback,
    useEffect,
    useRef,
    type Dispatch,
    type SetStateAction,
} from "react";
import { toast } from "sonner";
import { createRuntimeAudioEngine } from "@/lib/audio-engine";

const playbackEngine = createRuntimeAudioEngine();

function resumeMainPlayerIfPaused(pausedRef: { current: boolean }): void {
    if (!pausedRef.current) return;
    playbackEngine.play();
    pausedRef.current = false;
}

function createPreviewAudio(
    albumId: string,
    previewUrl: string,
    previewAudios: Map<string, HTMLAudioElement>,
    setCurrentPreview: Dispatch<SetStateAction<string | null>>,
    mainPlayerWasPausedRef: { current: boolean },
): HTMLAudioElement {
    const audio = new Audio(previewUrl);
    audio.onended = () => {
        setCurrentPreview(null);
        resumeMainPlayerIfPaused(mainPlayerWasPausedRef);
    };
    audio.onerror = () => {
        toast.error("Failed to load preview");
        setCurrentPreview(null);
        if (previewAudios.get(albumId) === audio) {
            previewAudios.delete(albumId);
        }
        resumeMainPlayerIfPaused(mainPlayerWasPausedRef);
    };
    previewAudios.set(albumId, audio);
    return audio;
}

function stopPreviewAudio(audio?: HTMLAudioElement): void {
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
}

function startPreview(
    albumId: string,
    previewUrl: string,
    previewAudios: Map<string, HTMLAudioElement>,
    setCurrentPreview: Dispatch<SetStateAction<string | null>>,
    mainPlayerWasPausedRef: { current: boolean },
): void {
    if (playbackEngine.isPlaying()) {
        playbackEngine.pause();
        mainPlayerWasPausedRef.current = true;
    }

    const audio = previewAudios.get(albumId) ?? createPreviewAudio(
        albumId,
        previewUrl,
        previewAudios,
        setCurrentPreview,
        mainPlayerWasPausedRef,
    );
    audio.play().then(() => {
        setCurrentPreview(albumId);
    }).catch((error) => {
        toast.error("Failed to play preview: " + error.message);
        setCurrentPreview(null);
        resumeMainPlayerIfPaused(mainPlayerWasPausedRef);
    });
}

/**
 * Executes usePreviewPlayer.
 */
export function usePreviewPlayer() {
    const [currentPreview, setCurrentPreview] = useState<string | null>(null);
    const previewAudiosRef = useRef<Map<string, HTMLAudioElement>>(new Map());
    const mainPlayerWasPausedRef = useRef(false);

    // Cleanup audio on unmount
    useEffect(() => {
        return () => {
            previewAudiosRef.current.forEach((audio) => {
                audio.pause();
                audio.src = "";
            });
            resumeMainPlayerIfPaused(mainPlayerWasPausedRef);
        };
    }, []);

    const handleTogglePreview = useCallback(
        (albumId: string, previewUrl: string) => {
            if (!previewUrl) {
                toast.error("No preview available for this album");
                return;
            }

            // Stop currently playing preview if any
            if (currentPreview && currentPreview !== albumId) {
                stopPreviewAudio(previewAudiosRef.current.get(currentPreview));
            }

            // Toggle the clicked preview
            if (currentPreview === albumId) {
                stopPreviewAudio(previewAudiosRef.current.get(albumId));
                setCurrentPreview(null);
                resumeMainPlayerIfPaused(mainPlayerWasPausedRef);
                return;
            }

            startPreview(
                albumId,
                previewUrl,
                previewAudiosRef.current,
                setCurrentPreview,
                mainPlayerWasPausedRef,
            );
        },
        [currentPreview],
    );

    return {
        currentPreview,
        handleTogglePreview,
    };
}
