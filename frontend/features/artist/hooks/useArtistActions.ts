import { useCallback } from 'react';
import { useAudioControls } from '@/lib/audio-context';
import { useListenTogether } from "@/lib/listen-together-context";
import { Artist, Album, Track } from '../types';
import { shuffleArray } from '@/utils/shuffle';
import { loadOwnedArtistTracksNewestFirst } from '@/lib/artistPlayback';
import { toast } from "sonner";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

export function useArtistActions() {
  // Use controls-only hook to avoid re-renders from playback state changes
  const { playTrack: playTrackFromContext, playTracks, addTracksToQueue } = useAudioControls();
  const { isInGroup } = useListenTogether();

  const playAll = useCallback(
    async (artist: Artist | null, albums: Album[]) => {
      if (!artist) {
        return;
      }

      try {
        const allTracks = await loadOwnedArtistTracksNewestFirst({
          artistId: artist.id,
          artistName: artist.name,
          albums: albums.map((album) => ({
            id: album.id,
            title: album.title,
            year: album.year,
            coverArt: album.coverArt || album.coverUrl,
            owned: album.owned,
          })),
        });

        if (allTracks.length === 0) {
          return;
        }

        // Play tracks in order (newest album first, track 1 to end, then next album)
        playTracks(allTracks);
      } catch (error) {
        sharedFrontendLogger.error('Failed to play artist:', error);
      }
    },
    [playTracks]
  );

  const shufflePlay = useCallback(
    async (artist: Artist | null, albums: Album[]) => {
      if (!artist) {
        return;
      }

      try {
        const allTracks = await loadOwnedArtistTracksNewestFirst({
          artistId: artist.id,
          artistName: artist.name,
          albums: albums.map((album) => ({
            id: album.id,
            title: album.title,
            year: album.year,
            coverArt: album.coverArt || album.coverUrl,
            owned: album.owned,
          })),
        });

        if (allTracks.length === 0) {
          return;
        }

        // Shuffle all tracks randomly
        const shuffledTracks = shuffleArray(allTracks);

        playTracks(shuffledTracks);
      } catch (error) {
        sharedFrontendLogger.error('Failed to shuffle play artist:', error);
      }
    },
    [playTracks]
  );

  const playTrack = useCallback(
    (track: Track, artist: Artist) => {
      try {
        // Format track for audio context
        const formattedTrack = {
          id: track.id,
          title: track.title,
          artist: { name: artist.name, id: artist.id },
          album: {
            title: track.album?.title || 'Unknown Album',
            coverArt: track.album?.coverArt,
            id: track.album?.id,
          },
          duration: track.duration,
        };

        playTrackFromContext(formattedTrack);
      } catch (error) {
        sharedFrontendLogger.error('Failed to play track:', error);
      }
    },
    [playTrackFromContext]
  );

  const addAllToQueue = useCallback(
    async (artist: Artist | null, albums: Album[]) => {
      if (!artist) {
        return;
      }

      try {
        const allTracks = await loadOwnedArtistTracksNewestFirst({
          artistId: artist.id,
          artistName: artist.name,
          albums: albums.map((album) => ({
            id: album.id,
            title: album.title,
            year: album.year,
            coverArt: album.coverArt || album.coverUrl,
            owned: album.owned,
          })),
        });

        if (allTracks.length === 0) {
          toast.info("No local tracks available to add");
          return;
        }

        if (isInGroup) {
          playTracks(allTracks, 0);
          return;
        }

        addTracksToQueue(allTracks, { silent: true });

        toast.success(
          allTracks.length === 1
            ? 'Added 1 track to queue'
            : `Added ${allTracks.length} tracks to queue`
        );
      } catch (error) {
        sharedFrontendLogger.error('Failed to add artist to queue:', error);
        toast.error("Failed to add tracks to queue");
      }
    },
    [addTracksToQueue, isInGroup, playTracks]
  );

  return {
    playAll,
    shufflePlay,
    playTrack,
    addAllToQueue,
  };
}
