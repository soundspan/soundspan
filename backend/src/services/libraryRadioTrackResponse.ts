/**
 * Maps a radio track row with album and artist relations to the frontend
 * playback track shape.
 */
// Radio queue rows combine Prisma scalars with included relations.
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
