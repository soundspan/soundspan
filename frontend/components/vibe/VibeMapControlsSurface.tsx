"use client";

/** Floating controls and mutually exclusive map panels. */

import { AlchemyTray } from "./AlchemyTray";
import { FiltersPanel } from "./FiltersPanel";
import { JourneyPanel } from "./JourneyPanel";
import { NowPlayingConnected } from "./NowPlayingConnected";
import { QueuePanel } from "./QueuePanel";
import { SpotlightSearch } from "./SpotlightSearch";
import { SweepChip } from "./SweepChip";
import { SWEEP_CAP } from "./sweepCollect";
import { TravelPanel } from "./TravelPanel";
import { getMoodColor } from "./types";
import type { VibeMapViewModel } from "./useVibeMapController";
import { ViewControls } from "./ViewControls";

function NowPlaying({ model }: { model: VibeMapViewModel }) {
    const current = model.audio.currentTrack;
    if (!current) return null;
    const mapTrack = model.trackById.get(current.id);
    return <NowPlayingConnected track={current} onMapPresent={!!mapTrack}
        moodColor={mapTrack ? getMoodColor(mapTrack.dominantMood) : null}
        onFlyTo={model.locateNowPlaying} />;
}

function MapViewControls({ model }: { model: VibeMapViewModel }) {
    const current = model.audio.currentTrack;
    const canLocate = !!(current && model.trackById.has(current.id));
    const locateHint = canLocate ? "Fly to now playing" : current ?
        "Now playing isn't on the map" : "Nothing playing";
    const journeyHint = model.vibe.canStartJourney ?
        "Plan a journey from the current track" : model.vibe.mode === "alchemy" ?
            "Close alchemy (Esc) first" : "Play a track (or pick one in Travel) to start a journey";
    return <ViewControls onZoomIn={() => model.camera.zoomByCenter(1.3)}
        onZoomOut={() => model.camera.zoomByCenter(1 / 1.3)} onReset={model.camera.resetView}
        layoutMode={model.layout.layoutMode} layoutDisabled={model.data.tracks.length === 0}
        onToggleLayout={model.layout.toggleLayoutMode} brushArmed={model.sweep.brushArmed}
        onToggleBrush={model.sweep.toggleBrush} canLocate={canLocate} locateHint={locateHint}
        onLocate={model.locateNowPlaying} canStartJourney={model.vibe.canStartJourney}
        journeyHint={journeyHint} onStartJourney={model.vibe.startJourney}
        queueOpen={model.aux.auxSurface === "queue"}
        onToggleQueue={() => model.aux.toggleAuxSurface("queue")}
        queueCount={Math.max(0, (model.audio.queue?.length ?? 0) -
            (model.audio.currentIndex ?? -1) - 1)} trailMode={model.trail.trailMode}
        onSetTrailMode={model.trail.setTrailMode}
        trailPopoverOpen={model.aux.auxSurface === "trail"}
        onToggleTrailPopover={() => model.aux.toggleAuxSurface("trail")}
        trailEmpty={model.trail.trailIds.length === 0} onClearTrail={model.trail.clearTrail}
        onSaveTrail={model.trail.saveTrail} trailSaving={model.trail.trailSaving}
        aboutPopoverOpen={model.aux.auxSurface === "about"}
        onToggleAboutPopover={() => model.aux.toggleAuxSurface("about")}
        isFullscreen={model.shell.fullscreen}
        onToggleFullscreen={() => model.shell.setFullscreen(!model.shell.fullscreen)} />;
}

function FloatingControls({ model }: { model: VibeMapViewModel }) {
    return <div className="pointer-events-none absolute inset-0 z-30">
        <div className="absolute top-3 left-3 flex flex-col items-start gap-2">
            {!model.shell.fullscreen && model.props.headerSlot}
            <NowPlaying model={model} />
        </div>
        <div className="absolute top-3 left-1/2 -translate-x-1/2">
            <SpotlightSearch tracks={model.data.tracks} onLocate={model.locateTrack}
                onResults={(ids) => model.shell.setSpotlightHighlight(ids)}
                onClear={() => model.shell.setSpotlightHighlight(null)} />
        </div>
        <div className="absolute top-3 right-3"><MapViewControls model={model} /></div>
        <FiltersPanel filters={model.filters} total={model.data.tracks.length}
            expanded={model.presentation.filtersOpen}
            onExpandedChange={model.shell.setFiltersExpanded}
            reducedMotion={model.shell.reducedMotion} compact={model.shell.smallScreen} />
    </div>;
}

function ModePanels({ model }: { model: VibeMapViewModel }) {
    if (model.aux.auxOpen) return null;
    return <>
        {model.vibe.travel && <TravelPanel view={model.vibe.travel} />}
        {model.vibe.journey && <JourneyPanel view={model.vibe.journey} />}
        {model.vibe.alchemy && <AlchemyTray view={model.vibe.alchemy} />}
    </>;
}

function QueueSurface({ model }: { model: VibeMapViewModel }) {
    if (!model.presentation.queuePanelVisible) return null;
    return <QueuePanel queue={model.audio.queue ?? []}
        currentIndex={model.audio.currentIndex ?? -1} onClose={model.aux.closeAux}
        onReorder={model.audioControls.moveQueueItem}
        onRemove={model.audioControls.removeFromQueue}
        reorderDisabled={model.together.isInGroup} />;
}

function SweepSurface({ model }: { model: VibeMapViewModel }) {
    const result = model.sweep.result;
    if (!result) return null;
    return <SweepChip count={result.ids.length} capped={result.ids.length >= SWEEP_CAP}
        onPlay={model.sweep.play} onQueue={model.sweep.queue} onSave={model.sweep.save}
        saving={model.sweep.saving} onDismiss={model.sweep.dismissResult} />;
}

/** Render floating controls and panel-slot occupants. */
export function VibeMapControlsSurface({ model }: { model: VibeMapViewModel }) {
    return <>
        <FloatingControls model={model} />
        <ModePanels model={model} />
        <QueueSurface model={model} />
        <SweepSurface model={model} />
    </>;
}
