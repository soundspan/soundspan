/**
 * Test script for Spotify album scraper diagnostics
 *
 * Usage:
 *   npx ts-node scripts/testAlbumScraper.ts [playlistId]
 *
 * Example:
 *   npx ts-node scripts/testAlbumScraper.ts 37i9dQZF1DXcBWIGoYBM5M
 */

import { spotifyService } from '../services/spotify';

async function testScraper() {
    const testPlaylistId = process.argv[2] || '37i9dQZF1DXcBWIGoYBM5M';
    console.log(`\n=== Spotify Album Scraper Test ===`);
    console.log(`Playlist ID: ${testPlaylistId}`);
    console.log(`Timestamp: ${new Date().toISOString()}\n`);

    console.log('Fetching playlist...');
    const startTime = Date.now();
    const playlist = await spotifyService.getPlaylist(testPlaylistId);
    const elapsed = Date.now() - startTime;

    if (!playlist) {
        console.error('FAILED: Could not fetch playlist');
        process.exit(1);
    }

    console.log(`\n--- Playlist Info ---`);
    console.log(`Name: ${playlist.name}`);
    console.log(`Owner: ${playlist.owner}`);
    console.log(`Track Count: ${playlist.trackCount}`);
    console.log(`Fetch Time: ${elapsed}ms\n`);

    const unknownAlbumTracks = playlist.tracks.filter(t => t.album === 'Unknown Album');
    const knownAlbumTracks = playlist.tracks.filter(t => t.album !== 'Unknown Album');

    console.log(`--- Album Resolution Stats ---`);
    console.log(`Total tracks: ${playlist.tracks.length}`);
    console.log(`Known albums: ${knownAlbumTracks.length} (${((knownAlbumTracks.length / playlist.tracks.length) * 100).toFixed(1)}%)`);
    console.log(`Unknown albums: ${unknownAlbumTracks.length} (${((unknownAlbumTracks.length / playlist.tracks.length) * 100).toFixed(1)}%)\n`);

    if (unknownAlbumTracks.length > 0) {
        console.log(`--- Tracks with Unknown Album (first 10) ---`);
        unknownAlbumTracks.slice(0, 10).forEach((t, i) => {
            console.log(`  ${i + 1}. "${t.title}" by ${t.artist}`);
            console.log(`     Spotify ID: ${t.spotifyId}`);
        });

        if (unknownAlbumTracks.length > 10) {
            console.log(`  ... and ${unknownAlbumTracks.length - 10} more\n`);
        }
    }

    if (knownAlbumTracks.length > 0) {
        console.log(`\n--- Sample Tracks with Known Albums (first 5) ---`);
        knownAlbumTracks.slice(0, 5).forEach((t, i) => {
            console.log(`  ${i + 1}. "${t.title}" by ${t.artist}`);
            console.log(`     Album: ${t.album} (ID: ${t.albumId})`);
        });
    }

    // Summary
    console.log(`\n--- Summary ---`);
    if (unknownAlbumTracks.length === 0) {
        console.log('SUCCESS: All tracks have album data resolved');
    } else if (unknownAlbumTracks.length < playlist.tracks.length * 0.1) {
        console.log(`PARTIAL SUCCESS: ${unknownAlbumTracks.length} tracks (${((unknownAlbumTracks.length / playlist.tracks.length) * 100).toFixed(1)}%) still have unknown albums`);
    } else {
        console.log(`WARNING: ${unknownAlbumTracks.length} tracks (${((unknownAlbumTracks.length / playlist.tracks.length) * 100).toFixed(1)}%) have unknown albums - scraper may need updating`);
    }
}

testScraper().catch(error => {
    console.error('Test script error:', error);
    process.exit(1);
});
