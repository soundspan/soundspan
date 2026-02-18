import { DiscoverySeeding, SeedArtist } from '../discoverySeeding';
import { prisma } from '../../../utils/db';
import { lidarrService } from '../../lidarr';

jest.mock('../../../utils/db', () => ({
    prisma: {
        play: {
            groupBy: jest.fn(),
        },
        album: {
            groupBy: jest.fn(),
            findFirst: jest.fn(),
        },
        artist: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
        },
        track: {
            findMany: jest.fn(),
        },
        ownedAlbum: {
            findFirst: jest.fn(),
        },
        discoveryAlbum: {
            findFirst: jest.fn(),
        },
        downloadJob: {
            findFirst: jest.fn(),
        },
    },
}));

jest.mock('../../lidarr', () => ({
    lidarrService: {
        isAlbumAvailable: jest.fn(),
    },
}));

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockLidarrService = lidarrService as jest.Mocked<typeof lidarrService>;

describe('DiscoverySeeding', () => {
    let seeding: DiscoverySeeding;

    beforeEach(() => {
        jest.clearAllMocks();
        seeding = new DiscoverySeeding();
    });

    describe('getSeedArtists', () => {
        const userId = 'user-123';

        it('should return top played artists with valid MBIDs', async () => {
            // Need at least 5 plays to not trigger fallback
            const recentPlays = [
                { trackId: 'track-1', _count: { id: 10 } },
                { trackId: 'track-2', _count: { id: 8 } },
                { trackId: 'track-3', _count: { id: 7 } },
                { trackId: 'track-4', _count: { id: 6 } },
                { trackId: 'track-5', _count: { id: 5 } },
            ];

            const tracks = [
                {
                    id: 'track-1',
                    album: {
                        artistId: 'artist-1',
                        artist: { id: 'artist-1', name: 'Artist One', mbid: 'valid-mbid-1' },
                    },
                },
                {
                    id: 'track-2',
                    album: {
                        artistId: 'artist-2',
                        artist: { id: 'artist-2', name: 'Artist Two', mbid: 'valid-mbid-2' },
                    },
                },
                {
                    id: 'track-3',
                    album: {
                        artistId: 'artist-3',
                        artist: { id: 'artist-3', name: 'Artist Three', mbid: 'valid-mbid-3' },
                    },
                },
                {
                    id: 'track-4',
                    album: {
                        artistId: 'artist-4',
                        artist: { id: 'artist-4', name: 'Artist Four', mbid: 'valid-mbid-4' },
                    },
                },
                {
                    id: 'track-5',
                    album: {
                        artistId: 'artist-5',
                        artist: { id: 'artist-5', name: 'Artist Five', mbid: 'valid-mbid-5' },
                    },
                },
            ];

            (mockPrisma.play.groupBy as jest.Mock).mockResolvedValue(recentPlays);
            (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(tracks);

            const result = await seeding.getSeedArtists(userId);

            expect(result).toHaveLength(5);
            expect(result[0]).toEqual({ name: 'Artist One', mbid: 'valid-mbid-1' });
            expect(result[1]).toEqual({ name: 'Artist Two', mbid: 'valid-mbid-2' });
        });

        it('should filter out artists with temp- MBIDs', async () => {
            // Need at least 5 plays to not trigger fallback
            const recentPlays = [
                { trackId: 'track-1', _count: { id: 10 } },
                { trackId: 'track-2', _count: { id: 8 } },
                { trackId: 'track-3', _count: { id: 7 } },
                { trackId: 'track-4', _count: { id: 6 } },
                { trackId: 'track-5', _count: { id: 5 } },
            ];

            const tracks = [
                {
                    id: 'track-1',
                    album: {
                        artistId: 'artist-1',
                        artist: { id: 'artist-1', name: 'Artist One', mbid: 'temp-12345' },
                    },
                },
                {
                    id: 'track-2',
                    album: {
                        artistId: 'artist-2',
                        artist: { id: 'artist-2', name: 'Artist Two', mbid: 'valid-mbid-2' },
                    },
                },
                {
                    id: 'track-3',
                    album: {
                        artistId: 'artist-3',
                        artist: { id: 'artist-3', name: 'Artist Three', mbid: 'valid-mbid-3' },
                    },
                },
                {
                    id: 'track-4',
                    album: {
                        artistId: 'artist-4',
                        artist: { id: 'artist-4', name: 'Artist Four', mbid: 'valid-mbid-4' },
                    },
                },
                {
                    id: 'track-5',
                    album: {
                        artistId: 'artist-5',
                        artist: { id: 'artist-5', name: 'Artist Five', mbid: 'valid-mbid-5' },
                    },
                },
            ];

            (mockPrisma.play.groupBy as jest.Mock).mockResolvedValue(recentPlays);
            (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(tracks);

            const result = await seeding.getSeedArtists(userId);

            // Should have 4 valid artists (artist-1 has temp- MBID)
            expect(result).toHaveLength(4);
            expect(result.find((a) => a.mbid === 'temp-12345')).toBeUndefined();
            expect(result[0]).toEqual({ name: 'Artist Two', mbid: 'valid-mbid-2' });
        });

        it('should filter out artists with null MBIDs', async () => {
            // Need at least 5 plays to not trigger fallback
            const recentPlays = [
                { trackId: 'track-1', _count: { id: 10 } },
                { trackId: 'track-2', _count: { id: 8 } },
                { trackId: 'track-3', _count: { id: 7 } },
                { trackId: 'track-4', _count: { id: 6 } },
                { trackId: 'track-5', _count: { id: 5 } },
            ];

            const tracks = [
                {
                    id: 'track-1',
                    album: {
                        artistId: 'artist-1',
                        artist: { id: 'artist-1', name: 'Artist One', mbid: null },
                    },
                },
                {
                    id: 'track-2',
                    album: {
                        artistId: 'artist-2',
                        artist: { id: 'artist-2', name: 'Artist Two', mbid: 'valid-mbid-2' },
                    },
                },
                {
                    id: 'track-3',
                    album: {
                        artistId: 'artist-3',
                        artist: { id: 'artist-3', name: 'Artist Three', mbid: 'valid-mbid-3' },
                    },
                },
                {
                    id: 'track-4',
                    album: {
                        artistId: 'artist-4',
                        artist: { id: 'artist-4', name: 'Artist Four', mbid: 'valid-mbid-4' },
                    },
                },
                {
                    id: 'track-5',
                    album: {
                        artistId: 'artist-5',
                        artist: { id: 'artist-5', name: 'Artist Five', mbid: 'valid-mbid-5' },
                    },
                },
            ];

            (mockPrisma.play.groupBy as jest.Mock).mockResolvedValue(recentPlays);
            (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(tracks);

            const result = await seeding.getSeedArtists(userId);

            // Should have 4 valid artists (artist-1 has null MBID)
            expect(result).toHaveLength(4);
            expect(result.find((a) => a.mbid === null)).toBeUndefined();
            expect(result[0]).toEqual({ name: 'Artist Two', mbid: 'valid-mbid-2' });
        });

        it('should handle empty listening history by falling back to library', async () => {
            const albumGroups = [
                { artistId: 'artist-1', _count: { id: 5 } },
                { artistId: 'artist-2', _count: { id: 3 } },
            ];

            const artists = [
                { id: 'artist-1', name: 'Library Artist One', mbid: 'lib-mbid-1' },
                { id: 'artist-2', name: 'Library Artist Two', mbid: 'lib-mbid-2' },
            ];

            (mockPrisma.play.groupBy as jest.Mock).mockResolvedValue([]);
            (mockPrisma.album.groupBy as jest.Mock).mockResolvedValue(albumGroups);
            (mockPrisma.artist.findMany as jest.Mock).mockResolvedValue(artists);

            const result = await seeding.getSeedArtists(userId);

            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({ name: 'Library Artist One', mbid: 'lib-mbid-1' });
            expect(mockPrisma.album.groupBy).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { location: 'LIBRARY' },
                })
            );
        });

        it('should fall back to library when fewer than 5 recent plays', async () => {
            const recentPlays = [
                { trackId: 'track-1', _count: { id: 2 } },
            ];

            const albumGroups = [
                { artistId: 'artist-1', _count: { id: 5 } },
            ];

            const artists = [
                { id: 'artist-1', name: 'Library Artist', mbid: 'lib-mbid-1' },
            ];

            (mockPrisma.play.groupBy as jest.Mock).mockResolvedValue(recentPlays);
            (mockPrisma.album.groupBy as jest.Mock).mockResolvedValue(albumGroups);
            (mockPrisma.artist.findMany as jest.Mock).mockResolvedValue(artists);

            const result = await seeding.getSeedArtists(userId);

            expect(mockPrisma.album.groupBy).toHaveBeenCalled();
            expect(result[0].name).toBe('Library Artist');
        });

        it('should respect seedCount parameter', async () => {
            const recentPlays = Array.from({ length: 20 }, (_, i) => ({
                trackId: `track-${i}`,
                _count: { id: 20 - i },
            }));

            const tracks = Array.from({ length: 20 }, (_, i) => ({
                id: `track-${i}`,
                album: {
                    artistId: `artist-${i}`,
                    artist: { id: `artist-${i}`, name: `Artist ${i}`, mbid: `mbid-${i}` },
                },
            }));

            (mockPrisma.play.groupBy as jest.Mock).mockResolvedValue(recentPlays);
            (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(tracks);

            const result = await seeding.getSeedArtists(userId, 5);

            expect(result.length).toBeLessThanOrEqual(5);
        });

        it('should deduplicate artists from multiple tracks', async () => {
            // Need at least 5 plays to not trigger fallback
            const recentPlays = [
                { trackId: 'track-1', _count: { id: 10 } },
                { trackId: 'track-2', _count: { id: 8 } },
                { trackId: 'track-3', _count: { id: 5 } },
                { trackId: 'track-4', _count: { id: 4 } },
                { trackId: 'track-5', _count: { id: 3 } },
            ];

            const tracks = [
                {
                    id: 'track-1',
                    album: {
                        artistId: 'artist-1',
                        artist: { id: 'artist-1', name: 'Same Artist', mbid: 'valid-mbid-1' },
                    },
                },
                {
                    id: 'track-2',
                    album: {
                        artistId: 'artist-1',
                        artist: { id: 'artist-1', name: 'Same Artist', mbid: 'valid-mbid-1' },
                    },
                },
                {
                    id: 'track-3',
                    album: {
                        artistId: 'artist-2',
                        artist: { id: 'artist-2', name: 'Different Artist', mbid: 'valid-mbid-2' },
                    },
                },
                {
                    id: 'track-4',
                    album: {
                        artistId: 'artist-1',
                        artist: { id: 'artist-1', name: 'Same Artist', mbid: 'valid-mbid-1' },
                    },
                },
                {
                    id: 'track-5',
                    album: {
                        artistId: 'artist-3',
                        artist: { id: 'artist-3', name: 'Third Artist', mbid: 'valid-mbid-3' },
                    },
                },
            ];

            (mockPrisma.play.groupBy as jest.Mock).mockResolvedValue(recentPlays);
            (mockPrisma.track.findMany as jest.Mock).mockResolvedValue(tracks);

            const result = await seeding.getSeedArtists(userId);

            // Should have 3 unique artists despite 5 tracks (artist-1 appears 3 times)
            expect(result).toHaveLength(3);
            expect(result.map((a) => a.name)).toEqual(['Same Artist', 'Different Artist', 'Third Artist']);
        });
    });

    describe('isArtistInLibrary', () => {
        it('should return true when artist found by MBID with albums', async () => {
            (mockPrisma.artist.findFirst as jest.Mock).mockResolvedValue({
                id: 'artist-1',
                mbid: 'valid-mbid',
                albums: [{ id: 'album-1' }],
            });

            const result = await seeding.isArtistInLibrary('valid-mbid');

            expect(result).toBe(true);
            expect(mockPrisma.artist.findFirst).toHaveBeenCalledWith({
                where: { mbid: 'valid-mbid' },
                include: { albums: { take: 1 } },
            });
        });

        it('should return false when artist found by MBID but has no albums', async () => {
            (mockPrisma.artist.findFirst as jest.Mock).mockResolvedValue({
                id: 'artist-1',
                mbid: 'valid-mbid',
                albums: [],
            });

            const result = await seeding.isArtistInLibrary('valid-mbid');

            expect(result).toBe(false);
        });

        it('should return false when artist not found', async () => {
            (mockPrisma.artist.findFirst as jest.Mock).mockResolvedValue(null);

            const result = await seeding.isArtistInLibrary('unknown-mbid');

            expect(result).toBe(false);
        });

        it('should skip temp- MBIDs and return false', async () => {
            const result = await seeding.isArtistInLibrary('temp-12345');

            expect(result).toBe(false);
            expect(mockPrisma.artist.findFirst).not.toHaveBeenCalled();
        });
    });

    describe('isAlbumOwned', () => {
        const userId = 'user-123';

        it('should return true when album found in OwnedAlbum table', async () => {
            (mockPrisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValue({
                rgMbid: 'album-mbid',
            });

            const result = await seeding.isAlbumOwned('album-mbid', userId);

            expect(result).toBe(true);
        });

        it('should return true when album found in Album table', async () => {
            (mockPrisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue({
                rgMbid: 'album-mbid',
            });

            const result = await seeding.isAlbumOwned('album-mbid', userId);

            expect(result).toBe(true);
        });

        it('should return true when album found in previous discovery', async () => {
            (mockPrisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue({
                rgMbid: 'album-mbid',
            });

            const result = await seeding.isAlbumOwned('album-mbid', userId);

            expect(result).toBe(true);
        });

        it('should return true when album has pending download', async () => {
            (mockPrisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.downloadJob.findFirst as jest.Mock).mockResolvedValue({
                targetMbid: 'album-mbid',
                status: 'pending',
            });

            const result = await seeding.isAlbumOwned('album-mbid', userId);

            expect(result).toBe(true);
        });

        it('should return true when album available in Lidarr', async () => {
            (mockPrisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.downloadJob.findFirst as jest.Mock).mockResolvedValue(null);
            mockLidarrService.isAlbumAvailable.mockResolvedValue(true);

            const result = await seeding.isAlbumOwned('album-mbid', userId);

            expect(result).toBe(true);
            expect(mockLidarrService.isAlbumAvailable).toHaveBeenCalledWith('album-mbid');
        });

        it('should return false when album not found anywhere', async () => {
            (mockPrisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.album.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue(null);
            (mockPrisma.downloadJob.findFirst as jest.Mock).mockResolvedValue(null);
            mockLidarrService.isAlbumAvailable.mockResolvedValue(false);

            const result = await seeding.isAlbumOwned('album-mbid', userId);

            expect(result).toBe(false);
        });
    });
});
