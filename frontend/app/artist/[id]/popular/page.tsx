import { redirect } from "next/navigation";

interface ArtistPopularPageProps {
    params: Promise<{
        id: string;
    }>;
}

/**
 * Renders the ArtistPopularPage component.
 */
export default async function ArtistPopularPage({
    params,
}: ArtistPopularPageProps) {
    const { id } = await params;
    redirect(`/artist/${encodeURIComponent(id)}#popular`);
}
