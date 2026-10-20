"use client";

import {
    keepPreviousData,
    useMutation,
    useQuery,
    useQueryClient,
} from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
    CreateMusicRequestInput,
    DenyStaleMusicRequestsInput,
    MusicRequest,
} from "@/lib/api/requests";
import { useAuth } from "@/lib/auth-context";
import {
    isOpenRequestStatus,
    requestAvailabilityFlags,
    requestPollInterval,
    requestsNavEntry,
    shouldRetryRequestQuery,
    type RequestsNavEntry,
} from "@/lib/musicRequests";
import { queryKeys } from "@/lib/queryKeys";

/** Every key sits under queryKeys.musicRequests() so one invalidation refreshes all. */
export const musicRequestKeys = {
    availability: ["music-requests", "availability"] as const,
    mineOpen: ["music-requests", "mine-open"] as const,
    page: (
        scope: "all" | "mine",
        status: string,
        offset: number,
        limit: number,
    ) => ["music-requests", scope, status, offset, limit] as const,
    counts: ["music-requests", "counts"] as const,
};

/** Upper bound of open requests fetched per status for the request buttons. */
const OPEN_REQUESTS_PER_STATUS = 100;
/** How often the admin pending-count badge refreshes. */
const COUNTS_REFRESH_MS = 60_000;
/** How often an availability probe that failed transiently is retried. */
const AVAILABILITY_RECHECK_MS = 60_000;

/**
 * Availability probe. A 404 (feature off) or 403 is final; other failures
 * retry and are rechecked each minute so a server restart does not hide the
 * request surfaces for the rest of the session.
 */
function useRequestAvailabilityQuery(enabled: boolean) {
    return useQuery({
        queryKey: musicRequestKeys.availability,
        queryFn: () => api.getRequestAvailability(),
        enabled,
        staleTime: 5 * 60_000,
        retry: shouldRetryRequestQuery,
        refetchInterval: (query) =>
            query.state.status === "error"
                ? requestPollInterval(
                      enabled,
                      query.state.status,
                      query.state.error,
                      AVAILABILITY_RECHECK_MS,
                  )
                : false,
    });
}

/**
 * Capability gate for the request flow: authenticated non-admins whose
 * server answers the availability probe. Admins keep direct downloads and
 * never see the request surfaces. Defaults closed on any error.
 */
export function useRequestsGate() {
    const { isAuthenticated, user } = useAuth();
    const eligible = Boolean(isAuthenticated) && user?.role !== "admin";
    const query = useRequestAvailabilityQuery(eligible);
    const flags = requestAvailabilityFlags(
        query.data,
        query.isError,
        query.error,
    );
    return {
        requestsEnabled: eligible && flags.enabled,
        remainingToday: query.data?.remainingToday ?? null,
    };
}

/**
 * Whether the request feature is on for any signed-in viewer, admins
 * included, whether the server has definitely said it is off, and the
 * server's decline cooldown (null until known).
 */
export function useRequestsFeature() {
    const { isAuthenticated } = useAuth();
    const query = useRequestAvailabilityQuery(Boolean(isAuthenticated));
    const flags = requestAvailabilityFlags(
        query.data,
        query.isError,
        query.error,
    );
    return {
        enabled: flags.enabled,
        /** True once the server has answered that requests are off. */
        off: flags.off,
        deniedCooldownDays: query.data?.deniedCooldownDays ?? null,
    };
}

async function fetchMyOpenRequests(): Promise<MusicRequest[]> {
    const [pending, approved] = await Promise.all([
        api.getMyMusicRequests({
            status: "pending",
            limit: OPEN_REQUESTS_PER_STATUS,
        }),
        api.getMyMusicRequests({
            status: "approved",
            limit: OPEN_REQUESTS_PER_STATUS,
        }),
    ]);
    return [...pending.requests, ...approved.requests];
}

/**
 * The caller's open (pending/approved) requests for the Request buttons;
 * disabled until the gate opens.
 */
export function useMyOpenMusicRequests(enabled: boolean) {
    return useQuery({
        queryKey: musicRequestKeys.mineOpen,
        queryFn: fetchMyOpenRequests,
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

/** Paging input for one page of the requests list. */
export interface MusicRequestPageQuery {
    scope: "all" | "mine";
    status: string;
    offset: number;
    limit: number;
    enabled: boolean;
}

/**
 * One page of requests: the admin queue ("all") or the caller's own
 * ("mine"); status "all" applies no filter. Keeps the previous page on
 * screen while the next one loads.
 */
export function useMusicRequestsPage(query: MusicRequestPageQuery) {
    const params = {
        status: query.status === "all" ? undefined : query.status,
        limit: query.limit,
        offset: query.offset,
    };
    return useQuery({
        queryKey: musicRequestKeys.page(
            query.scope,
            query.status,
            query.offset,
            query.limit,
        ),
        queryFn: () =>
            query.scope === "all"
                ? api.getMusicRequests(params)
                : api.getMyMusicRequests(params),
        enabled: query.enabled,
        staleTime: 15_000,
        placeholderData: keepPreviousData,
    });
}

/**
 * Admin request totals per status; refreshes once a minute for the badge,
 * keeps polling through transient errors, and stops after a 403/404.
 */
export function useMusicRequestCounts(enabled: boolean) {
    return useQuery({
        queryKey: musicRequestKeys.counts,
        queryFn: () => api.getMusicRequestCounts(),
        enabled,
        staleTime: 30_000,
        refetchInterval: (query) =>
            requestPollInterval(
                enabled,
                query.state.status,
                query.state.error,
                COUNTS_REFRESH_MS,
            ),
        retry: false,
    });
}

/**
 * Navigation entry for the requests page while the feature is on: the admin
 * queue with its pending badge or the caller's own list; otherwise null.
 */
export function useRequestsNavEntry(): RequestsNavEntry | null {
    const { user } = useAuth();
    const isAdmin = user?.role === "admin";
    const feature = useRequestsFeature();
    const counts = useMusicRequestCounts(isAdmin && feature.enabled);
    return requestsNavEntry({
        isAdmin,
        requestsEnabled: feature.enabled,
        pendingCount: counts.data?.pending ?? 0,
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

/** Admin bulk action: approve one requester's pending requests. */
export function useBulkApproveMusicRequests() {
    const invalidate = useInvalidateRequests();
    return useMutation({
        mutationFn: (userId: string) => api.bulkApproveMusicRequests(userId),
        onSettled: invalidate,
    });
}

/** Admin bulk action: decline pending requests older than a cutoff. */
export function useDenyStaleMusicRequests() {
    const invalidate = useInvalidateRequests();
    return useMutation({
        mutationFn: (input: DenyStaleMusicRequestsInput) =>
            api.denyStaleMusicRequests(input),
        onSettled: invalidate,
    });
}
