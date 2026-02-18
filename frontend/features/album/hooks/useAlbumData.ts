import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { api } from "@/lib/api";
import { useDownloadContext } from "@/lib/download-context";
import type { AlbumSource } from "../types";
import { useMemo, useEffect, useRef, useCallback } from "react";

export function useAlbumData(albumId?: string) {
    const params = useParams();
    const router = useRouter();
    const id = albumId || (params.id as string);
    const { downloadStatus } = useDownloadContext();
    const prevActiveCountRef = useRef(downloadStatus.activeDownloads.length);
    const {
        data: coreAlbum,
        isLoading: isCoreLoading,
        error: coreError,
        refetch: refetchCore,
    } = useQuery({
        queryKey: queryKeys.album(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Album ID is required");
            try {
                return await api.getAlbum(id, {
                    includeTracks: false,
                });
            } catch {
                return await api.getAlbumDiscovery(id, {
                    includeTracks: false,
                });
            }
        },
        enabled: !!id,
        staleTime: 10 * 60 * 1000,
        retry: 1,
        refetchInterval: downloadStatus.hasActiveDownloads ? 5000 : false,
    });

    const coreSource: AlbumSource | null = useMemo(() => {
        if (!coreAlbum) return null;
        return coreAlbum.owned === true ? "library" : "discovery";
    }, [coreAlbum]);

    const shouldHydrateDetails =
        !!id &&
        (coreSource === "library" || coreSource === "discovery") &&
        !!coreAlbum;

    const {
        data: detailedAlbum,
        isLoading: isDetailsLoading,
        isFetching: isDetailsFetching,
        refetch: refetchDetails,
    } = useQuery({
        queryKey: queryKeys.albumDetails(id || "", coreSource),
        queryFn: async () => {
            if (!id) throw new Error("Album ID is required");
            if (coreSource === "library") {
                return await api.getAlbum(id);
            }
            if (coreSource === "discovery") {
                return await api.getAlbumDiscovery(id, {
                    includeTracks: true,
                });
            }
            throw new Error("Album source is required");
        },
        enabled: shouldHydrateDetails,
        staleTime: 10 * 60 * 1000,
        retry: 1,
    });

    const album = detailedAlbum || coreAlbum;
    const detailsLoading =
        shouldHydrateDetails &&
        !detailedAlbum &&
        (isDetailsLoading || isDetailsFetching);

    const reloadAlbum = useCallback(async () => {
        await refetchCore();
        if (shouldHydrateDetails) {
            await refetchDetails();
        }
    }, [refetchCore, refetchDetails, shouldHydrateDetails]);

    useEffect(() => {
        const currentActiveCount = downloadStatus.activeDownloads.length;
        if (
            prevActiveCountRef.current > 0 &&
            currentActiveCount < prevActiveCountRef.current
        ) {
            void reloadAlbum();
        }
        prevActiveCountRef.current = currentActiveCount;
    }, [downloadStatus.activeDownloads.length, reloadAlbum]);

    // Determine source from merged album data (core or hydrated details)
    const source: AlbumSource | null = useMemo(() => {
        if (!album) return null;
        return album.owned === true ? "library" : "discovery";
    }, [album]);

    useEffect(() => {
        if (coreError && !isCoreLoading) {
            toast.error("Failed to load album");
            router.back();
        }
    }, [coreError, isCoreLoading, router]);

    return {
        album,
        loading: isCoreLoading,
        detailsLoading,
        source,
        reloadAlbum,
    };
}
