"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { CreateMusicRequestInput, MusicRequest } from "@/lib/api/requests";
import { useAuth } from "@/lib/auth-context";
import { isOpenRequestStatus } from "@/lib/musicRequests";
import { queryKeys } from "@/lib/queryKeys";

export const musicRequestKeys = {
    availability: ["music-requests", "availability"] as const,
    mine: ["music-requests", "mine"] as const,
    all: (status: string) => ["music-requests", "all", status] as const,
};

/**
 * Capability gate for the request flow: authenticated non-admins whose
 * server answers the availability probe. Admins keep direct downloads and
 * never see the request surfaces. Defaults closed on any error.
 */
export function useRequestsGate() {
    const { isAuthenticated, user } = useAuth();
    const eligible = Boolean(isAuthenticated) && user?.role !== "admin";
    const query = useQuery({
        queryKey: musicRequestKeys.availability,
        queryFn: () => api.getRequestAvailability(),
        enabled: eligible,
        staleTime: 5 * 60_000,
        retry: false,
    });
    return {
        requestsEnabled: eligible && query.data?.enabled === true,
        remainingToday: query.data?.remainingToday ?? null,
    };
}

/** The caller's own requests; disabled until the gate opens. */
export function useMyMusicRequests(enabled: boolean) {
    return useQuery({
        queryKey: musicRequestKeys.mine,
        queryFn: () => api.getMyMusicRequests(),
        enabled,
        staleTime: 30_000,
    });
}

/**
 * Release-group ids with an open (pending/approved) request by the caller.
 * Ids are lower-cased so lookups are case-insensitive; callers must
 * lower-case their probe too.
 */
export function openRequestRgMbids(
    requests: MusicRequest[] | undefined,
): Set<string> {
    const open = new Set<string>();
    for (const request of requests ?? []) {
        if (isOpenRequestStatus(request.status)) {
            open.add(request.rgMbid.toLowerCase());
        }
    }
    return open;
}

/** Admin list, optionally filtered by status ("all" fetches everything). */
export function useMusicRequestsAdmin(status: string, enabled: boolean) {
    return useQuery({
        queryKey: musicRequestKeys.all(status),
        queryFn: () =>
            api.getMusicRequests(status === "all" ? undefined : status),
        enabled,
        staleTime: 15_000,
    });
}

function useInvalidateRequests() {
    const queryClient = useQueryClient();
    return () =>
        queryClient.invalidateQueries({ queryKey: queryKeys.musicRequests() });
}

/** Submit a new album request; invalidates every request-scoped query. */
export function useCreateMusicRequest() {
    const invalidate = useInvalidateRequests();
    return useMutation({
        mutationFn: (input: CreateMusicRequestInput) =>
            api.createMusicRequest(input),
        onSettled: invalidate,
    });
}

/** Cancel one of the caller's own pending requests. */
export function useCancelMusicRequest() {
    const invalidate = useInvalidateRequests();
    return useMutation({
        mutationFn: (id: string) => api.cancelMusicRequest(id),
        onSettled: invalidate,
    });
}

/** Admin approve/deny actions. */
export function useReviewMusicRequest() {
    const invalidate = useInvalidateRequests();
    return useMutation({
        mutationFn: ({
            id,
            action,
            reason,
        }: {
            id: string;
            action: "approve" | "deny";
            reason?: string;
        }) =>
            action === "approve"
                ? api.approveMusicRequest(id)
                : api.denyMusicRequest(id, reason),
        onSettled: invalidate,
    });
}
