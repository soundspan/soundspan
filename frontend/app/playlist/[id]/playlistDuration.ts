/** Formats a playlist duration using the compact detail-page convention. */
export function formatPlaylistDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return hours > 0 ? `about ${hours} hr ${minutes} min` : `${minutes} min`;
}
