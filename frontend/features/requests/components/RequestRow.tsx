"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import type { MusicRequest } from "@/lib/api/requests";
import {
    formatRequestDate,
    requestStatusBadgeVariant,
} from "@/lib/musicRequests";
import {
    activeCooldownEnd,
    failedRequestHint,
    requestActionLabel,
    requestAlbumHref,
    requestArtistHref,
    requestRowStatusLabel,
} from "../requestViewModel";
import {
    RequestRowActions,
    type RequestRowHandlers,
} from "./RequestRowActions";

interface RequestRowProps extends RequestRowHandlers {
    request: MusicRequest;
    isAdmin: boolean;
    viewerId: string | undefined;
    busy: boolean;
    now: Date;
    /** Server cooldown setting; 0 hides cooldown hints, null means unknown. */
    deniedCooldownDays: number | null;
}

function requestMetaLine(request: MusicRequest, isAdmin: boolean): string {
    const parts: string[] = [];
    if (isAdmin && request.user) {
        parts.push(`Requested by ${request.user.username}`);
    }
    parts.push(formatRequestDate(request.createdAt));
    if (request.note) parts.push(`“${request.note}”`);
    if (request.status === "denied" && request.deniedReason) {
        parts.push(`Declined: ${request.deniedReason}`);
    }
    return parts.filter(Boolean).join(" · ");
}

function RequestDetail(props: {
    request: MusicRequest;
    isAdmin: boolean;
    now: Date;
    deniedCooldownDays: number | null;
}) {
    const { request } = props;
    if (request.status === "failed") {
        return (
            <p className="text-xs text-red-300/80">
                {failedRequestHint(props.isAdmin)}
            </p>
        );
    }
    const cooldownEnd = activeCooldownEnd(
        request,
        props.now,
        props.deniedCooldownDays,
    );
    if (cooldownEnd) {
        return (
            <p className="text-xs text-gray-500">
                Can be requested again after {formatRequestDate(cooldownEnd)}
            </p>
        );
    }
    return null;
}

/** One request with its links, status, follow-up detail, and actions. */
export function RequestRow(props: RequestRowProps) {
    const { request } = props;
    const openAlbumHref =
        request.status === "fulfilled" && request.albumId
            ? `/album/${request.albumId}`
            : null;
    return (
        <li className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
            <div className="min-w-0 flex-1 space-y-0.5">
                <p className="truncate text-sm font-medium text-white">
                    <Link
                        href={requestArtistHref(request)}
                        className="hover:underline"
                    >
                        {request.artistName}
                    </Link>{" "}
                    —{" "}
                    <Link
                        href={requestAlbumHref(request)}
                        className="hover:underline"
                    >
                        {request.albumTitle}
                    </Link>
                </p>
                <p className="truncate text-xs text-gray-400">
                    {requestMetaLine(request, props.isAdmin)}
                </p>
                <RequestDetail
                    request={request}
                    isAdmin={props.isAdmin}
                    now={props.now}
                    deniedCooldownDays={props.deniedCooldownDays}
                />
            </div>
            <Badge variant={requestStatusBadgeVariant(request.status)}>
                {requestRowStatusLabel(request, props.isAdmin)}
            </Badge>
            {openAlbumHref && (
                <Link
                    href={openAlbumHref}
                    aria-label={requestActionLabel("Open album", request)}
                    className="text-xs font-medium text-brand hover:underline"
                >
                    Open album
                </Link>
            )}
            <RequestRowActions {...props} />
        </li>
    );
}
