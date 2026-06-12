import { useCallback } from 'react';
import { useQueryClient } from "@tanstack/react-query";
import { useAudioControls } from '@/lib/audio-context';
import { api } from '@/lib/api';
import { Artist, Album, Track } from '../types';
import { shuffleArray } from '@/utils/shuffle';
import { loadOwnedArtistTracksNewestFirst } from '@/lib/artistPlayback';
import { buildOptimisticTrackPreferenceResponse } from '@/hooks/trackPreferenceOptimistic';
import { toAddToPlaylistRef } from '@/lib/trackRef';
import { toast } from "sonner";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

/**
 * Executes useArtistActions.
 */
export function useArtistActions() {
  const queryClient = useQueryClient();
  // Use controls-only hook to avoid re-renders from playback state changes
  const { playTrack: playTrackFromContext, playTracks, addTracksToQueue } = useAudioControls();

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

        addTracksToQueue(allTracks);
      } catch (error) {
        sharedFrontendLogger.error('Failed to add artist to queue:', error);
        toast.error("Failed to add tracks to queue");
      }
    },
    [addTracksToQueue]
  );

  const likeAllTracks = useCallback(
    async (artist: Artist | null, albums: Album[]) => {
      if (!artist) return;

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
          toast.info("No local tracks to like");
          return;
        }

        // Snapshot previous cache values for rollback
        const previousValues = new Map<string, unknown>();
        for (const track of allTracks) {
          previousValues.set(
            track.id,
            queryClient.getQueryData(["track-preference", track.id]),
          );
          queryClient.setQueryData(
            ["track-preference", track.id],
            buildOptimisticTrackPreferenceResponse(track.id, "thumbs_up")
          );
        }

        try {
          // Batch requests to avoid overwhelming the backend
          const BATCH_SIZE = 8;
          for (let i = 0; i < allTracks.length; i += BATCH_SIZE) {
            await Promise.all(
              allTracks.slice(i, i + BATCH_SIZE).map((track) =>
                api.setTrackPreference(track.id, "thumbs_up")
              )
            );
          }

          queryClient.invalidateQueries({ queryKey: ["library", "liked-playlist"] });
          toast.success(`Liked ${allTracks.length} tracks`);
        } catch (error) {
          // Rollback: restore previous cache values then refetch
          for (const track of allTracks) {
            const prev = previousValues.get(track.id);
            if (prev !== undefined) {
              queryClient.setQueryData(["track-preference", track.id], prev);
            } else {
              queryClient.removeQueries({ queryKey: ["track-preference", track.id] });
            }
          }
          for (const track of allTracks) {
            queryClient.invalidateQueries({ queryKey: ["track-preference", track.id] });
          }
          throw error;
        }
      } catch (error) {
        sharedFrontendLogger.error('Failed to like all artist tracks:', error);
        toast.error("Failed to like all tracks");
      }
    },
    [queryClient]
  );

  const addAllToPlaylist = useCallback(
    async (artist: Artist | null, albums: Album[], playlistId: string) => {
      if (!artist) return;

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
        toast.info("No local tracks to add");
        return;
      }

      // Batch requests to avoid overwhelming the backend
      const BATCH_SIZE = 8;
      let added = 0;
      for (let i = 0; i < allTracks.length; i += BATCH_SIZE) {
        const results = await Promise.allSettled(
          allTracks.slice(i, i + BATCH_SIZE).map((track) =>
            api.addTrackToPlaylist(playlistId, toAddToPlaylistRef({
              id: track.id,
              title: track.title,
              artist: typeof track.artist === 'object' ? track.artist?.name : track.artist,
              album: typeof track.album === 'object' ? track.album?.title : track.album,
              duration: track.duration,
            }))
          )
        );
        added += results.filter((r) => r.status === "fulfilled").length;
      }

      const failed = allTracks.length - added;
      if (failed > 0 && added === 0) {
        toast.error("Failed to add tracks to playlist");
        throw new Error(`All ${failed} tracks failed to add to playlist`);
      } else if (failed > 0) {
        toast.warning(`Added ${added} tracks, ${failed} failed`);
      } else {
        toast.success(`Added ${allTracks.length} tracks to playlist`);
      }
    },
    []
  );

  return {
    playAll,
    shufflePlay,
    playTrack,
    addAllToQueue,
    likeAllTracks,
    addAllToPlaylist,
  };
}
