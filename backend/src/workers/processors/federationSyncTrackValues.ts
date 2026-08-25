import type { TrackEnvelope } from "./federationSyncPage";

function syncedAudioFeatures(attributes: TrackEnvelope["attributes"]) {
    return {
        bpm: attributes.bpm,
        beatsCount: attributes.beatsCount,
        key: attributes.key,
        keyScale: attributes.keyScale,
        keyStrength: attributes.keyStrength,
        energy: attributes.energy,
        loudness: attributes.loudness,
        loudnessLufs: attributes.loudnessLufs,
        truePeakDb: attributes.truePeakDb,
        dynamicRange: attributes.dynamicRange,
        danceability: attributes.danceability,
        valence: attributes.valence,
        arousal: attributes.arousal,
        instrumentalness: attributes.instrumentalness,
        acousticness: attributes.acousticness,
        speechiness: attributes.speechiness,
        moodHappy: attributes.moodHappy,
        moodSad: attributes.moodSad,
        moodRelaxed: attributes.moodRelaxed,
        moodAggressive: attributes.moodAggressive,
        moodParty: attributes.moodParty,
        moodAcoustic: attributes.moodAcoustic,
        moodElectronic: attributes.moodElectronic,
        danceabilityMl: attributes.danceabilityMl,
        moodTags: attributes.moodTags ?? [],
        essentiaGenres: attributes.essentiaGenres ?? [],
        lastfmTags: attributes.lastfmTags ?? [],
    };
}

/** Map one validated peer track into the persisted federated-track values. */
export function syncedFederationTrackValues(
    item: TrackEnvelope,
    albumId: string,
) {
    const attributes = item.attributes;
    return {
        albumId,
        title: attributes.title,
        discNo: attributes.discNo,
        trackNo: attributes.trackNo,
        duration: attributes.duration,
        mime: attributes.mime,
        fileSize: attributes.fileSize,
        fileModified: new Date(item.updatedAt),
        recordingMbid: attributes.recordingMbid,
        isrc: attributes.isrc,
        audioHash: attributes.audioHash,
        ...syncedAudioFeatures(attributes),
        origin: "FEDERATED" as const,
        filePath: null,
        removedAt: null,
    };
}
