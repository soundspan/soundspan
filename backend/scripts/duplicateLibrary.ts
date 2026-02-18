import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function duplicateLibrary() {
    console.log("Starting library duplication...");

    // Fetch all existing artists with their albums and tracks
    const artists = await prisma.artist.findMany({
        include: {
            albums: {
                include: {
                    tracks: true,
                },
            },
        },
    });

    console.log(`Found ${artists.length} artists to duplicate.`);

    const COPIES = 3;

    for (let i = 1; i <= COPIES; i++) {
        console.log(`Creating copy set ${i}...`);

        for (const artist of artists) {
            // Skip if it's already a copy (to prevent exponential growth if run multiple times)
            if (artist.name.includes("_copy_") || artist.name.includes("(Copy"))
                continue;

            const newArtistMbid = `${artist.mbid}-copy-${i}`;
            const newArtistName = `${artist.name} (Copy ${i})`;

            try {
                // Prepare artist data, handling Json types explicitly
                const artistData: any = {
                    ...artist,
                    id: undefined,
                    mbid: newArtistMbid,
                    name: newArtistName,
                    normalizedName: newArtistName.toLowerCase(),
                    genres: artist.genres ?? undefined,
                    similarArtistsJson: artist.similarArtistsJson ?? undefined,
                    userGenres: artist.userGenres ?? undefined,
                    searchVector: undefined, // Exclude computed field
                    albums: {
                        create: artist.albums.map((album) => ({
                            ...album,
                            id: undefined,
                            artistId: undefined,
                            rgMbid: `${album.rgMbid}-copy-${i}`,
                            title: `${album.title} (Copy ${i})`,
                            genres: album.genres ?? undefined,
                            userGenres: album.userGenres ?? undefined,
                            searchVector: undefined, // Exclude computed field
                            tracks: {
                                create: album.tracks.map((track) => ({
                                    ...track,
                                    id: undefined,
                                    albumId: undefined,
                                    filePath: track.filePath.replace(
                                        /(\.[^.]+)$/,
                                        `-copy-${i}$1`,
                                    ),
                                    title: `${track.title} (Copy ${i})`,
                                    searchVector: undefined, // Exclude computed field
                                })),
                            },
                        })),
                    },
                };

                // Remove relation fields that shouldn't be copied directly
                delete artistData.similarFrom;
                delete artistData.similarTo;
                delete artistData.ownedAlbums;

                await prisma.artist.create({
                    data: artistData,
                });
                console.log(`  Created ${newArtistName}`);
            } catch (error) {
                console.error(`  Failed to duplicate ${artist.name}:`, error);
            }
        }
    }

    console.log("Library duplication complete.");
}

duplicateLibrary()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
