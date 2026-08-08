"use client";

/** Compose the focused VibeMap hooks into one view model. */

import { useCallback, useMemo, type ReactNode } from "react";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useListenTogether } from "@/lib/listen-together-context";
import { upcomingOnMapPoints } from "./flightPlan";
import { fitViewport } from "./mapViewport";
import { useAuxSurface } from "./useAuxSurface";
import { useMapCamera } from "./useMapCamera";
import { useMapFilters } from "./useMapFilters";
import { useMapGestures } from "./useMapGestures";
import { useMapLayout } from "./useMapLayout";
import { useMapSweep } from "./useMapSweep";
import { useTrailDisplay } from "./useTrailDisplay";
import { useVibeMode } from "./useVibeMode";
import { useJourneyCameraFrame, useTravelCameraFollow,
    useVibeMapLocations } from "./useVibeMapCameraEffects";
import { useMapDimensions, useVibeMapData } from "./useVibeMapData";
import { useVibeMapEscape, useVibeMapShell } from "./useVibeMapShell";
import { deriveVibeMapPresentation, findTrackAtScreenPoint } from "./vibeMapModel";
import type { MapTrack } from "./types";

interface VibeMapControllerProps { headerSlot?: ReactNode; bottomInset?: number }

function mapTracksById(tracks: readonly MapTrack[]): ReadonlyMap<string, MapTrack> {
    const byId = new Map<string, MapTrack>();
    for (const track of tracks) byId.set(track.id, track);
    return byId;
}

function useMapCore(data: ReturnType<typeof useVibeMapData>,
    dims: ReturnType<typeof useMapDimensions>, shell: ReturnType<typeof useVibeMapShell>,
    audio: ReturnType<typeof useAudioState>, audioControls: ReturnType<typeof useAudioControls>) {
    const filters = useMapFilters(data.tracks);
    const layout = useMapLayout({ tracks: data.tracks, reducedMotion: shell.reducedMotion });
    const camera = useMapCamera({ dims, reducedMotion: shell.reducedMotion });
    const trackById = useMemo(() => mapTracksById(data.tracks), [data.tracks]);
    const controls = useMemo(() => ({ playTrack: audioControls.playTrack,
        playTracks: audioControls.playTracks, addToQueue: audioControls.addToQueue }),
    [audioControls.playTrack, audioControls.playTracks, audioControls.addToQueue]);
    const vibe = useVibeMode({ trackById, currentTrack: audio.currentTrack,
        controls, quantiles: data.quantiles });
    const sweep = useMapSweep({ tracks: data.tracks, positions: layout.positions,
        mask: filters.mask, viewportRef: camera.viewportRef, trackById, controls });
    const aux = useAuxSurface({ mode: vibe.mode, sweepChipOpen: sweep.chipOpen });
    const trail = useTrailDisplay({ posOf: layout.posOf });
    const plan = useMemo(() => upcomingOnMapPoints(audio.queue ?? [],
        audio.currentIndex ?? -1, layout.posOf), [audio.queue, audio.currentIndex, layout.posOf]);
    return { filters, layout, camera, trackById, vibe, sweep, aux, trail, plan };
}

function useMapInteraction(core: ReturnType<typeof useMapCore>,
    data: ReturnType<typeof useVibeMapData>, dims: ReturnType<typeof useMapDimensions>,
    shell: ReturnType<typeof useVibeMapShell>, currentTrackId: string | null) {
    const hitTest = useCallback((clientX: number, clientY: number, radiusScale = 1) => {
        const viewport = core.camera.viewport;
        const container = shell.containerRef.current;
        if (!viewport || !container) return null;
        return findTrackAtScreenPoint({ clientX, clientY,
            rect: container.getBoundingClientRect(), viewport,
            fitScale: fitViewport(dims).scale, tracks: data.tracks,
            positions: core.layout.positions, mask: core.filters.mask, radiusScale });
    }, [core.camera.viewport, core.layout.positions, core.filters.mask,
        shell.containerRef, dims, data.tracks]);
    const onTap = useCallback((id: string, mods: { ctrlOrMeta: boolean; shift: boolean }) => {
        core.sweep.dismissResult();
        core.vibe.onDotClick(id, mods);
    }, [core.sweep.dismissResult, core.vibe.onDotClick]);
    const onEmptyTap = useCallback(() => core.sweep.chipOpen ?
        core.sweep.dismissResult() : core.vibe.onEmptyClick(),
    [core.sweep.chipOpen, core.sweep.dismissResult, core.vibe.onEmptyClick]);
    const gestures = useMapGestures({ containerRef: shell.containerRef,
        camera: core.camera, hitTest, sweep: core.sweep, onTap, onEmptyTap });
    const locations = useVibeMapLocations({ dims, viewportRef: core.camera.viewportRef,
        positionOf: core.layout.posOf, animate: core.camera.animateCameraTo });
    const locateNowPlaying = useCallback(() => {
        if (currentTrackId) locations.locateNowPlaying(currentTrackId);
    }, [currentTrackId, locations.locateNowPlaying]);
    const locateTrack = useCallback((id: string) => {
        if (locations.locateSearchResult(id)) shell.setSpotlightHighlight(new Set([id]));
    }, [locations.locateSearchResult, shell.setSpotlightHighlight]);
    return { gestures, locateNowPlaying, locateTrack };
}

/** Build the complete controller consumed by the presentational map view. */
export function useVibeMapController(props: VibeMapControllerProps) {
    const shell = useVibeMapShell();
    const data = useVibeMapData();
    const dims = useMapDimensions(shell.containerRef);
    const audio = useAudioState();
    const audioControls = useAudioControls();
    const together = useListenTogether();
    const core = useMapCore(data, dims, shell, audio, audioControls);
    const interaction = useMapInteraction(core, data, dims, shell, audio.currentTrack?.id ?? null);
    useTravelCameraFollow({ originId: core.vibe.travel?.currentId ?? null, dims,
        viewportRef: core.camera.viewportRef, positionOf: core.layout.posOf,
        animate: core.camera.animateCameraTo, gestureActive: interaction.gestures.isGestureActive });
    useJourneyCameraFrame({ journey: core.vibe.journey, dims,
        viewportRef: core.camera.viewportRef, positionOf: core.layout.posOf,
        animate: core.camera.animateCameraTo });
    const escHintVisible = useVibeMapEscape({ sweepOpen: core.sweep.chipOpen,
        dismissSweep: core.sweep.dismissResult, auxSurface: core.aux.auxSurface,
        closeAux: core.aux.closeAux, mode: core.vibe.mode, exitMode: core.vibe.exitToExplore,
        fullscreen: shell.fullscreen, setFullscreen: shell.setFullscreen });
    const presentation = deriveVibeMapPresentation({ mode: core.vibe.mode,
        sweepHighlight: core.sweep.highlight, vibeHighlight: core.vibe.highlightIds,
        spotlightHighlight: shell.spotlightHighlight, trail: core.trail.trailPoints,
        plan: core.plan, filtersExpanded: shell.filtersExpanded,
        auxSurface: core.aux.auxSurface, sweepChipOpen: core.sweep.chipOpen });
    const view = {
        props,
        shell: { spotlightHighlight: shell.spotlightHighlight,
            setSpotlightHighlight: shell.setSpotlightHighlight,
            fullscreen: shell.fullscreen, setFullscreen: shell.setFullscreen,
            filtersExpanded: shell.filtersExpanded, setFiltersExpanded: shell.setFiltersExpanded,
            hintsDismissed: shell.hintsDismissed, dismissHints: shell.dismissHints,
            reducedMotion: shell.reducedMotion, smallScreen: shell.smallScreen,
            coarsePointer: shell.coarsePointer },
        data, dims, audio, audioControls, together,
        filters: core.filters, layout: core.layout,
        camera: { viewport: core.camera.viewport, zoomByCenter: core.camera.zoomByCenter,
            resetView: core.camera.resetView },
        trackById: core.trackById, vibe: core.vibe, sweep: core.sweep,
        aux: core.aux, trail: core.trail, plan: core.plan,
        ...interaction, presentation, escHintVisible,
    };
    return { containerRef: shell.containerRef, view };
}

/** Ref-free controller projection shared by the focused presentational views. */
export type VibeMapViewModel = ReturnType<typeof useVibeMapController>["view"];
