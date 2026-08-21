import { useCallback, useEffect, useMemo, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { useDownloadContext } from "@/lib/download-context";
import { loadAlbumDetails, loadCoreAlbum } from "../albumHydration";
import { resolveAlbumSource, type AlbumSource } from "../types";

function useCoreAlbumQuery(albumId: string, hasActiveDownloads: boolean) {
    return useQuery({
        queryKey: queryKeys.album(albumId),
        queryFn: () => loadCoreAlbum(albumId),
        enabled: Boolean(albumId),
        staleTime: 10 * 60 * 1000,
        retry: 1,
        refetchInterval: hasActiveDownloads ? 5000 : false,
    });
}

function useAlbumDetailsQuery(
    albumId: string,
    source: AlbumSource | null,
    enabled: boolean,
) {
    return useQuery({
        queryKey: queryKeys.albumDetails(albumId, source),
        queryFn: () => loadAlbumDetails(albumId, source),
        enabled,
        staleTime: 10 * 60 * 1000,
        retry: 1,
    });
}

function useRefreshAfterDownload(activeCount: number, reload: () => void) {
    const previousActiveCount = useRef(activeCount);
    useEffect(() => {
        if (previousActiveCount.current > activeCount) reload();
        previousActiveCount.current = activeCount;
    }, [activeCount, reload]);
}

function useAlbumLoadError(error: Error | null, loading: boolean) {
    const router = useRouter();
    useEffect(() => {
        if (error && !loading) {
            toast.error("Failed to load album");
            router.back();
        }
    }, [error, loading, router]);
}

/** Loads an album core record and hydrates its source-specific details. */
export function useAlbumData(albumId?: string) {
    const params = useParams();
    const id = albumId || (params.id as string);
    const { downloadStatus } = useDownloadContext();
    const core = useCoreAlbumQuery(id, downloadStatus.hasActiveDownloads);
    const coreSource = useMemo(
        () => resolveAlbumSource(core.data),
        [core.data],
    );
    const shouldHydrate = Boolean(id && core.data && coreSource);
    const details = useAlbumDetailsQuery(id, coreSource, shouldHydrate);
    const album = details.data || core.data;
    const reloadAlbum = useCallback(async () => {
        await core.refetch();
        if (shouldHydrate) await details.refetch();
    }, [core, details, shouldHydrate]);
    useRefreshAfterDownload(
        downloadStatus.activeDownloads.length,
        () => void reloadAlbum(),
    );
    useAlbumLoadError(core.error, core.isLoading);

    return {
        album,
        loading: core.isLoading,
        detailsLoading:
            shouldHydrate &&
            !details.data &&
            (details.isLoading || details.isFetching),
        source: useMemo(() => resolveAlbumSource(album), [album]),
        reloadAlbum,
    };
}
