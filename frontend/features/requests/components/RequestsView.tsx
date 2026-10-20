"use client";

import { useState } from "react";
import Link from "next/link";
import { Inbox, Timer } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FilterPills } from "@/components/ui/FilterPills";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import {
    useMusicRequestCounts,
    useMusicRequestsPage,
    useMyOpenMusicRequests,
    useRequestsFeature,
} from "@/hooks/useMusicRequests";
import type { MusicRequest } from "@/lib/api/requests";
import {
    REQUEST_FILTER_OPTIONS,
    type MusicRequestFilter,
} from "@/lib/musicRequests";
import { useRequestActions } from "../hooks/useRequestActions";
import {
    REQUEST_PAGE_SIZE,
    bulkApproveConfirmMessage,
    clampRequestPage,
    requestPageCount,
} from "../requestViewModel";
import { DeclineRequestDialog } from "./DeclineRequestDialog";
import { DeclineStaleDialog } from "./DeclineStaleDialog";
import { RequestPagination } from "./RequestPagination";
import { RequestRow } from "./RequestRow";
import type { RequestRowHandlers } from "./RequestRowActions";

interface RequestsViewProps {
    isAdmin: boolean;
    viewerId: string | undefined;
}

function EmptyState(props: { isAdmin: boolean; filtered: boolean }) {
    return (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-6 py-12 text-center">
            <Inbox className="h-8 w-8 text-white/30" />
            <p className="text-sm text-gray-400">
                {props.filtered
                    ? "No requests match this filter."
                    : props.isAdmin
                      ? "No requests yet. When users request albums, they show up here for review."
                      : "You haven't requested anything yet. Find an album that isn't in the library and hit Request."}
            </p>
            {!props.isAdmin && (
                <Link
                    href="/library"
                    className="text-sm font-medium text-brand hover:underline"
                >
                    Browse the library
                </Link>
            )}
        </div>
    );
}

function HeaderActions(props: {
    isAdmin: boolean;
    filter: MusicRequestFilter;
    onFilterChange: (value: MusicRequestFilter) => void;
    onDeclineStale: () => void;
}) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            <FilterPills
                options={REQUEST_FILTER_OPTIONS}
                value={props.filter}
                onChange={props.onFilterChange}
                size="segmented"
                className="flex-wrap"
                aria-label="Request status filter"
            />
            {props.isAdmin && (
                <button
                    type="button"
                    onClick={props.onDeclineStale}
                    className="flex items-center gap-1.5 rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-gray-300 transition-all hover:bg-white/10 hover:text-white"
                >
                    <Timer className="h-3.5 w-3.5" />
                    Decline stale
                </button>
            )}
        </div>
    );
}

/** Pending total for the header badge: server counts for admins, own open requests otherwise. */
function usePendingCount(isAdmin: boolean, featureEnabled: boolean): number {
    const counts = useMusicRequestCounts(isAdmin && featureEnabled);
    const open = useMyOpenMusicRequests(!isAdmin && featureEnabled);
    if (!featureEnabled) return 0;
    if (isAdmin) return counts.data?.pending ?? 0;
    return (open.data ?? []).filter((row) => row.status === "pending").length;
}

/** Dialog targets for the row and header actions. */
function useRequestDialogs() {
    const [declineTarget, setDeclineTarget] = useState<MusicRequest | null>(
        null,
    );
    const [approveAllTarget, setApproveAllTarget] =
        useState<MusicRequest | null>(null);
    const [staleOpen, setStaleOpen] = useState(false);
    return {
        declineTarget,
        setDeclineTarget,
        approveAllTarget,
        setApproveAllTarget,
        staleOpen,
        setStaleOpen,
    };
}

/**
 * Filter, page, and the page query. A page left past the end (after rows
 * were declined or approved away) snaps back to the last page once fresh
 * data for it arrives.
 */
function useRequestListState(isAdmin: boolean, featureOff: boolean) {
    const [filter, setFilter] = useState<MusicRequestFilter>("all");
    const [page, setPage] = useState(1);
    const query = useMusicRequestsPage({
        scope: isAdmin ? "all" : "mine",
        status: filter,
        offset: (page - 1) * REQUEST_PAGE_SIZE,
        limit: REQUEST_PAGE_SIZE,
        enabled: !featureOff,
    });
    const total = query.data?.total ?? 0;
    const pageCount = requestPageCount(total, REQUEST_PAGE_SIZE);
    const clamped = clampRequestPage(page, total, REQUEST_PAGE_SIZE);
    if (query.data && !query.isPlaceholderData && clamped !== page) {
        setPage(clamped);
    }
    const changeFilter = (value: MusicRequestFilter) => {
        setFilter(value);
        setPage(1);
    };
    return { filter, changeFilter, page, setPage, pageCount, query };
}

function FeatureOffState() {
    return (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-6 py-12 text-center">
            <Inbox className="h-8 w-8 text-white/30" />
            <p className="text-sm text-gray-400">
                Music requests are turned off on this server.
            </p>
        </div>
    );
}

function ErrorState(props: { onRetry: () => void; onFirstPage?: () => void }) {
    return (
        <div
            role="alert"
            className="flex flex-col items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-6 py-12 text-center"
        >
            <p className="text-sm text-gray-400">
                The requests could not be loaded.
            </p>
            <div className="flex gap-3">
                <button
                    type="button"
                    onClick={props.onRetry}
                    className="text-sm font-medium text-brand hover:underline"
                >
                    Try again
                </button>
                {props.onFirstPage && (
                    <button
                        type="button"
                        onClick={props.onFirstPage}
                        className="text-sm font-medium text-gray-300 hover:underline"
                    >
                        Go to the first page
                    </button>
                )}
            </div>
        </div>
    );
}

function RequestList(props: {
    rows: MusicRequest[];
    isAdmin: boolean;
    viewerId: string | undefined;
    busy: boolean;
    deniedCooldownDays: number | null;
    handlers: RequestRowHandlers;
}) {
    const [now] = useState(() => new Date());
    return (
        <ul className="space-y-2">
            {props.rows.map((request) => (
                <RequestRow
                    key={request.id}
                    request={request}
                    isAdmin={props.isAdmin}
                    viewerId={props.viewerId}
                    busy={props.busy}
                    now={now}
                    deniedCooldownDays={props.deniedCooldownDays}
                    {...props.handlers}
                />
            ))}
        </ul>
    );
}

function RequestsBody(props: {
    list: ReturnType<typeof useRequestListState>;
    featureOff: boolean;
    isAdmin: boolean;
    viewerId: string | undefined;
    busy: boolean;
    deniedCooldownDays: number | null;
    handlers: RequestRowHandlers;
}) {
    const { list } = props;
    const rows = list.query.data?.requests ?? [];
    if (props.featureOff) return <FeatureOffState />;
    if (list.query.isError) {
        return (
            <ErrorState
                onRetry={() => void list.query.refetch()}
                onFirstPage={list.page > 1 ? () => list.setPage(1) : undefined}
            />
        );
    }
    if (list.query.isLoading) {
        return (
            <div className="flex justify-center py-16">
                <GradientSpinner size="md" />
            </div>
        );
    }
    if (rows.length === 0) {
        return (
            <EmptyState
                isAdmin={props.isAdmin}
                filtered={list.filter !== "all"}
            />
        );
    }
    return <RequestList {...props} rows={rows} />;
}

function RequestDialogs(props: {
    dialogs: ReturnType<typeof useRequestDialogs>;
    actions: ReturnType<typeof useRequestActions>;
    deniedCooldownDays: number | null;
}) {
    const { dialogs, actions } = props;
    const approveAllUser = dialogs.approveAllTarget?.user;
    return (
        <>
            <DeclineRequestDialog
                key={dialogs.declineTarget?.id ?? "none"}
                request={dialogs.declineTarget}
                deniedCooldownDays={props.deniedCooldownDays}
                onClose={() => dialogs.setDeclineTarget(null)}
                onConfirm={actions.decline}
            />
            <ConfirmDialog
                isOpen={Boolean(approveAllUser)}
                onClose={() => dialogs.setApproveAllTarget(null)}
                onConfirm={() => {
                    if (approveAllUser) {
                        actions.approveAll(
                            approveAllUser.id,
                            approveAllUser.username,
                        );
                    }
                }}
                title={`Approve all from ${approveAllUser?.username ?? ""}`}
                message={bulkApproveConfirmMessage(
                    approveAllUser?.username ?? "",
                )}
                confirmText="Approve all"
                variant="info"
            />
            <DeclineStaleDialog
                key={dialogs.staleOpen ? "open" : "closed"}
                isOpen={dialogs.staleOpen}
                onClose={() => dialogs.setStaleOpen(false)}
                onConfirm={actions.declineStale}
            />
        </>
    );
}

/** Role-aware, paged request list: admins review everything, users see their own. */
export function RequestsView({ isAdmin, viewerId }: RequestsViewProps) {
    const feature = useRequestsFeature();
    const list = useRequestListState(isAdmin, feature.off);
    const pendingCount = usePendingCount(isAdmin, feature.enabled);
    const actions = useRequestActions();
    const dialogs = useRequestDialogs();
    const handlers: RequestRowHandlers = {
        onApprove: actions.approve,
        onDecline: dialogs.setDeclineTarget,
        onCancel: actions.cancel,
        onApproveAll: dialogs.setApproveAllTarget,
    };

    return (
        <div className="min-h-screen px-4 py-6 md:px-8">
            <PageHeader
                title={isAdmin ? "Requests" : "My Requests"}
                subtitle={
                    isAdmin
                        ? "Review album requests from users and approve or decline them."
                        : "Albums you've asked to add to the library."
                }
                icon={Inbox}
                badge={
                    pendingCount > 0 ? (
                        <Badge variant="warning">{pendingCount} pending</Badge>
                    ) : null
                }
                actions={
                    feature.off ? null : (
                        <HeaderActions
                            isAdmin={isAdmin}
                            filter={list.filter}
                            onFilterChange={list.changeFilter}
                            onDeclineStale={() => dialogs.setStaleOpen(true)}
                        />
                    )
                }
            />
            <div className="mx-auto mt-6 max-w-4xl">
                <RequestsBody
                    list={list}
                    featureOff={feature.off}
                    isAdmin={isAdmin}
                    viewerId={viewerId}
                    busy={actions.busy}
                    deniedCooldownDays={feature.deniedCooldownDays}
                    handlers={handlers}
                />
                <RequestPagination
                    page={list.page}
                    pageCount={list.pageCount}
                    disabled={list.query.isFetching}
                    onChange={list.setPage}
                />
            </div>
            <RequestDialogs
                dialogs={dialogs}
                actions={actions}
                deniedCooldownDays={feature.deniedCooldownDays}
            />
        </div>
    );
}
