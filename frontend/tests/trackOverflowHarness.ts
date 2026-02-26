import React from "react";

type ModuleMocker = {
    module: (
        specifier: string,
        options: {
            namedExports?: Record<string, unknown>;
            defaultExport?: unknown;
        }
    ) => void;
};

type TrackOverflowHarnessOptions = {
    useAudioControls: () => Record<string, unknown>;
    useAudioState: () => Record<string, unknown>;
};

export const trackOverflowIcon = (props: Record<string, unknown>) =>
    React.createElement("i", props);

export function installTrackOverflowHarness(
    moduleMocker: ModuleMocker,
    options: TrackOverflowHarnessOptions
): void {
    moduleMocker.module("@/utils/cn", {
        namedExports: {
            cn: (...values: Array<string | false | null | undefined>) =>
                values.filter(Boolean).join(" "),
        },
    });

    moduleMocker.module("@/lib/audio-controls-context", {
        namedExports: {
            useAudioControls: options.useAudioControls,
        },
    });

    moduleMocker.module("@/lib/audio-state-context", {
        namedExports: {
            useAudioState: options.useAudioState,
        },
    });

    moduleMocker.module("@/components/ui/PlaylistSelector", {
        namedExports: {
            PlaylistSelector: (props: { isOpen: boolean }) =>
                props.isOpen
                    ? React.createElement(
                          "div",
                          { "data-testid": "playlist-selector" },
                          "PlaylistSelector"
                      )
                    : null,
        },
    });

    moduleMocker.module("@/utils/artistRoute", {
        namedExports: {
            getArtistHref: (artist: { id?: string; name?: string }) =>
                artist.id
                    ? `/artist/${artist.id}`
                    : artist.name
                      ? `/artist/${encodeURIComponent(artist.name)}`
                      : null,
        },
    });

    moduleMocker.module("sonner", {
        namedExports: {
            toast: {
                success: () => undefined,
                error: () => undefined,
                info: () => undefined,
            },
        },
    });
}
