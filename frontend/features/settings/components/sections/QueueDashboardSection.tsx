"use client";

/**
 * Admin entry point to the Bull Board queue dashboard. The dashboard is a
 * server-rendered page under /api/admin/queues that cannot carry the app's
 * bearer token, so opening it first asks the server for a short-lived,
 * path-scoped cookie and then opens the page in a new tab.
 */

import { useState } from "react";
import { ExternalLink, Loader2, LogOut } from "lucide-react";
import { SettingsSection } from "../ui";
import { api } from "@/lib/api";
import { createFrontendLogger } from "@/lib/logger";

const logger = createFrontendLogger("Settings.QueueDashboardSection");

/** Where Bull Board is mounted; the cookie is scoped to exactly this path. */
export const QUEUE_DASHBOARD_PATH = "/api/admin/queues";

type DashboardStatus =
    | "idle"
    | "opening"
    | "open"
    | "closing"
    | "closed"
    | "error";

const STATUS_TEXT: Record<DashboardStatus, string> = {
    idle: "Access lasts 15 minutes from the moment you open it.",
    opening: "Preparing dashboard access…",
    open: "Dashboard opened in a new tab. Access expires after 15 minutes; reopen from here when it does.",
    closing: "Ending dashboard access…",
    closed: "Dashboard access ended.",
    error: "Couldn't open the dashboard. Check the backend logs and try again.",
};

type OpenWindow = (url: string, target: string, features: string) => unknown;

/** Open the dashboard page in a new, opener-less tab. */
export function openDashboardTab(open: OpenWindow): void {
    open(QUEUE_DASHBOARD_PATH, "_blank", "noopener,noreferrer");
}

/** Render the queue dashboard access controls. */
export function QueueDashboardSection() {
    const [status, setStatus] = useState<DashboardStatus>("idle");
    const busy = status === "opening" || status === "closing";

    const handleOpen = async () => {
        setStatus("opening");
        try {
            await api.createQueueDashboardSession();
            openDashboardTab(window.open.bind(window));
            setStatus("open");
        } catch (error) {
            logger.error("Failed to open the queue dashboard", error);
            setStatus("error");
        }
    };

    const handleClose = async () => {
        setStatus("closing");
        try {
            await api.closeQueueDashboardSession();
            setStatus("closed");
        } catch (error) {
            logger.error("Failed to end queue dashboard access", error);
            setStatus("error");
        }
    };

    return (
        <SettingsSection
            id="queue-dashboard"
            title="Queue Dashboard"
            description="Inspect and retry background jobs in Bull Board. Opening it grants this browser a 15-minute cookie that works only for the dashboard."
        >
            <div className="flex flex-wrap items-center gap-3">
                <button
                    type="button"
                    onClick={handleOpen}
                    disabled={busy}
                    className="inline-flex items-center gap-2 px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {status === "opening" ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <ExternalLink className="w-4 h-4" />
                    )}
                    Open queue dashboard
                </button>
                <button
                    type="button"
                    onClick={handleClose}
                    disabled={busy}
                    className="inline-flex items-center gap-2 px-4 py-1.5 text-sm text-gray-300 border border-white/10 rounded-full hover:text-white hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {status === "closing" ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <LogOut className="w-4 h-4" />
                    )}
                    End dashboard access
                </button>
            </div>
            <p
                role="status"
                className={`mt-3 text-xs ${status === "error" ? "text-red-300" : "text-gray-400"}`}
            >
                {STATUS_TEXT[status]}
            </p>
        </SettingsSection>
    );
}
