/**
 * Maps a radio track row (with album/artist relations and analysis columns)
 * to the frontend playback Track shape.
 *
 * Extracted from radio.ts (its only caller) to keep that route module
 * inside its file-size baseline.
 */

// The radio queue rows mix Track columns with included relations and are
// consumed by an untyped response payload; the transform mirrors that.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function transformRadioTrack(track: any, vibeSourceFeatures: unknown) {
    return {
        id: track.id,
        title: track.title,
        duration: track.duration,
        trackNo: track.trackNo,
        filePath: track.filePath,
        loudnessLufs: track.loudnessLufs,
        truePeakDb: track.truePeakDb,
        artist: {
            id: track.album.artist.id,
            name: track.album.artist.name,
        },
        album: {
            id: track.album.id,
            title: track.album.title,
            coverArt: track.album.coverUrl,
            albumLoudnessLufs: track.album.albumLoudnessLufs,
            albumTruePeakDb: track.album.albumTruePeakDb,
        },
        // Include audio features for vibe mode visualization (if available)
        ...(vibeSourceFeatures
            ? {
                  audioFeatures: {
                      bpm: track.bpm,
                      energy: track.energy,
                      valence: track.valence,
                      arousal: track.arousal,
                      danceability: track.danceability,
                      keyScale: track.keyScale,
                      instrumentalness: track.instrumentalness,
                      analysisMode: track.analysisMode,
                      // ML Mood predictions for enhanced visualization
                      moodHappy: track.moodHappy,
                      moodSad: track.moodSad,
                      moodRelaxed: track.moodRelaxed,
                      moodAggressive: track.moodAggressive,
                      moodParty: track.moodParty,
                      moodAcoustic: track.moodAcoustic,
                      moodElectronic: track.moodElectronic,
                  },
              }
            : {}),
    };
}
