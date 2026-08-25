"use client";

import { useState, useRef, useCallback } from "react";
import {
    SettingsRow,
    SettingsInput,
    SettingsSelect,
    SettingsToggle,
    IntegrationCard,
} from "../ui";
import { SystemSettings } from "../../types";
import {
    ExternalLink,
    CheckCircle,
    XCircle,
    Loader2,
    AlertTriangle,
    Music2,
} from "lucide-react";
import { InlineStatus } from "@/components/ui/InlineStatus";
import { api } from "@/lib/api";
import { useDeviceAuthPolling } from "@/hooks/useDeviceAuthPolling";
import { useConnectionTest } from "@/features/settings/hooks/useConnectionTest";

interface TidalCardProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (
        service: string,
    ) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

const QUALITY_OPTIONS = [
    { value: "LOW", label: "Low (AAC 96 kbps)" },
    { value: "HIGH", label: "High (AAC 320 kbps)" },
    { value: "LOSSLESS", label: "Lossless (FLAC 16-bit / 44.1 kHz)" },
    {
        value: "HI_RES_LOSSLESS",
        label: "Max / Hi-Res (FLAC up to 24-bit / 192 kHz)",
    },
];

/**
 * Renders the TidalCard component.
 */
export function TidalCard({
    settings,
    onUpdate,
    onTest,
    isTesting,
}: TidalCardProps) {
    const {
        status: testStatus,
        message: testMessage,
        runTest,
        reset,
    } = useConnectionTest({
        loadingMessage: "Checking TIDAL...",
        successMessage: "Connected to TIDAL",
    });

    const [authMessage, setAuthMessage] = useState("");
    const authResultRef = useRef<Awaited<
        ReturnType<typeof api.tidalPollAuth>
    > | null>(null);

    const handleTest = () => runTest(() => onTest("tidal"));

    const initiateAuth = useCallback(async () => {
        const deviceAuth = await api.tidalDeviceAuth();
        let authLink = deviceAuth.verification_uri_complete;
        if (authLink && !authLink.startsWith("http"))
            authLink = `https://${authLink}`;
        return {
            deviceCode: deviceAuth.device_code,
            verificationUri: authLink,
            userCode: deviceAuth.user_code,
            pollIntervalMs: (deviceAuth.interval || 5) * 1000,
            expiresAtMs: Date.now() + (deviceAuth.expires_in || 300) * 1000,
        };
    }, []);

    const pollAuth = useCallback(async (deviceCode: string) => {
        const result = await api.tidalPollAuth(deviceCode);
        if (!result.success) return { status: "pending" } as const;
        authResultRef.current = result;
        return { status: "success" } as const;
    }, []);

    const handleAuthSuccess = useCallback(() => {
        const result = authResultRef.current;
        if (!result) return;
        setAuthMessage(`Authenticated as ${result.username || result.user_id}`);
        onUpdate({
            tidalEnabled: true,
            tidalConnected: true,
            tidalUserId: result.user_id || "",
            tidalCountryCode: result.country_code || "US",
        });
    }, [onUpdate]);

    const {
        phase: authState,
        session: authSession,
        error: authError,
        start: startAuthentication,
    } = useDeviceAuthPolling({
        initiate: initiateAuth,
        poll: pollAuth,
        onSessionStarted: (session) => {
            setAuthMessage("Waiting for you to approve...");
            window.open(
                session.verificationUri,
                "_blank",
                "noopener,noreferrer",
            );
        },
        onSuccess: handleAuthSuccess,
        expiredMessage: "Device code expired. Please try again.",
        startErrorMessage: "Failed to start device auth",
    });
    const authUrl = authSession?.verificationUri || "";
    const handleAuthenticate = useCallback(async () => {
        setAuthMessage("Requesting device code...");
        await startAuthentication();
    }, [startAuthentication]);

    const isAuthenticated = !!(
        settings.tidalConnected && settings.tidalEnabled
    );

    const statusText = settings.tidalEnabled
        ? isAuthenticated
            ? `Enabled (User: ${settings.tidalUserId})`
            : "Enabled — not authenticated"
        : "Disabled";

    const statusColor: "green" | "gray" =
        settings.tidalEnabled && isAuthenticated ? "green" : "gray";

    const warningBanner = (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-200/80">
                Not affiliated with or endorsed by TIDAL. Intended for personal
                use with your own subscription. You are responsible for
                complying with TIDAL&apos;s Terms of Service and applicable
                copyright laws.
            </p>
        </div>
    );

    return (
        <IntegrationCard
            icon={<Music2 className="w-5 h-5 text-cyan-400" />}
            title="TIDAL"
            statusText={statusText}
            statusColor={statusColor}
            connected={false}
            expanded={settings.tidalEnabled}
            warning={warningBanner}
            headerAction={
                <SettingsToggle
                    id="tidal-enabled"
                    checked={settings.tidalEnabled}
                    onChange={(checked) => onUpdate({ tidalEnabled: checked })}
                />
            }
        >
            <div className="space-y-1">
                {/* Authentication */}
                <SettingsRow
                    label="TIDAL Account"
                    description={
                        isAuthenticated ? (
                            <span className="flex items-center gap-1.5 text-green-400">
                                <CheckCircle className="w-3 h-3" />
                                Logged in (User: {settings.tidalUserId})
                            </span>
                        ) : (
                            <span className="flex items-center gap-1.5">
                                Authenticate with your TIDAL account via device
                                code
                                <a
                                    href="https://tidal.com"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-brand hover:underline"
                                >
                                    <ExternalLink className="w-3 h-3" />
                                    TIDAL
                                </a>
                            </span>
                        )
                    }
                >
                    <div className="flex flex-col gap-2">
                        <button
                            onClick={handleAuthenticate}
                            disabled={
                                authState === "loading" ||
                                authState === "polling"
                            }
                            className="px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full
                                hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                        >
                            {authState === "loading" && (
                                <span className="inline-flex items-center gap-2">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    Starting...
                                </span>
                            )}
                            {authState === "polling" && (
                                <span className="inline-flex items-center gap-2">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    Waiting for approval...
                                </span>
                            )}
                            {authState !== "loading" &&
                                authState !== "polling" &&
                                (isAuthenticated
                                    ? "Re-authenticate"
                                    : "Authenticate with TIDAL")}
                        </button>

                        {authState === "polling" && authUrl && (
                            <p className="text-xs text-white/60">
                                If the browser didn&apos;t open, visit:{" "}
                                <a
                                    href={authUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-brand hover:underline break-all"
                                >
                                    {authUrl}
                                </a>
                            </p>
                        )}

                        {authState === "success" && (
                            <p className="text-xs text-green-400 flex items-center gap-1">
                                <CheckCircle className="w-3 h-3" />{" "}
                                {authMessage}
                            </p>
                        )}

                        {authState === "error" && (
                            <p className="text-xs text-red-400 flex items-center gap-1">
                                <XCircle className="w-3 h-3" /> {authError}
                            </p>
                        )}
                    </div>
                </SettingsRow>

                {/* Quality */}
                <SettingsRow
                    label="Download Quality"
                    description="Audio quality for TIDAL downloads (requires matching TIDAL subscription)"
                >
                    <SettingsSelect
                        value={settings.tidalQuality || "HIGH"}
                        onChange={(v) =>
                            onUpdate({
                                tidalQuality:
                                    v as SystemSettings["tidalQuality"],
                            })
                        }
                        options={QUALITY_OPTIONS}
                    />
                </SettingsRow>

                {/* Country code */}
                <SettingsRow
                    label="Country Code"
                    description="Your TIDAL account region (auto-detected on login)"
                >
                    <SettingsInput
                        value={settings.tidalCountryCode || "US"}
                        onChange={(v) => onUpdate({ tidalCountryCode: v })}
                        placeholder="US"
                        className="w-24"
                    />
                </SettingsRow>

                {/* File template */}
                <SettingsRow
                    label="File Naming Template"
                    description={
                        <div className="space-y-2">
                            <span>
                                How downloaded files are organized. Use{" "}
                                <code className="text-xs text-white/60">/</code>{" "}
                                to create folders.
                            </span>
                            <details className="text-xs">
                                <summary className="cursor-pointer text-brand hover:underline select-none">
                                    Show available variables
                                </summary>
                                <div className="mt-2 space-y-2 text-white/60">
                                    <div>
                                        <p className="text-white/80 font-medium mb-1">
                                            Track / Item
                                        </p>
                                        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                                            <code>{"{item.number}"}</code>
                                            <span>
                                                Track number (use{" "}
                                                <code>{":02d"}</code> for
                                                zero-padded)
                                            </span>
                                            <code>{"{item.volume}"}</code>
                                            <span>Disc / volume number</span>
                                            <code>{"{item.title}"}</code>
                                            <span>Track title</span>
                                            <code>
                                                {"{item.title_version}"}
                                            </code>
                                            <span>
                                                Title + version, e.g. &quot;One
                                                More Time (Radio Edit)&quot;
                                            </span>
                                            <code>{"{item.artist}"}</code>
                                            <span>Primary artist</span>
                                            <code>{"{item.artists}"}</code>
                                            <span>All main artists</span>
                                            <code>{"{item.features}"}</code>
                                            <span>Featured artists</span>
                                            <code>{"{item.version}"}</code>
                                            <span>
                                                Version string (e.g.
                                                &quot;Remastered&quot;)
                                            </span>
                                            <code>{"{item.quality}"}</code>
                                            <span>Audio quality</span>
                                            <code>{"{item.isrc}"}</code>
                                            <span>ISRC code</span>
                                            <code>{"{item.bpm}"}</code>
                                            <span>BPM (if available)</span>
                                            <code>{"{item.explicit}"}</code>
                                            <span>
                                                &quot;E&quot; if explicit
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-white/80 font-medium mb-1">
                                            Album
                                        </p>
                                        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                                            <code>{"{album.artist}"}</code>
                                            <span>Album artist</span>
                                            <code>{"{album.artists}"}</code>
                                            <span>All album artists</span>
                                            <code>{"{album.title}"}</code>
                                            <span>Album title</span>
                                            <code>{"{album.date:%Y}"}</code>
                                            <span>
                                                Release year (date is
                                                formattable)
                                            </span>
                                            <code>{"{album.release}"}</code>
                                            <span>
                                                Type: ALBUM, EP, or SINGLE
                                            </span>
                                            <code>{"{album.explicit}"}</code>
                                            <span>
                                                &quot;E&quot; if explicit
                                            </span>
                                        </div>
                                    </div>
                                    <div>
                                        <p className="text-white/80 font-medium mb-1">
                                            Examples
                                        </p>
                                        <div className="space-y-1">
                                            <div>
                                                <code className="text-white/50">
                                                    {
                                                        "{album.artist}/{album.title}/{item.volume}-{item.number:02d} {item.title}"
                                                    }
                                                </code>
                                            </div>
                                            <div className="pl-3 text-white/40">
                                                → Pink Floyd/The Wall/1-04 The
                                                Happiest Days of Our Lives
                                            </div>
                                            <div>
                                                <code className="text-white/50">
                                                    {
                                                        "{album.artist}/{album.title} ({album.date:%Y})/{item.number:02d}. {item.title}"
                                                    }
                                                </code>
                                            </div>
                                            <div className="pl-3 text-white/40">
                                                → Pink Floyd/The Dark Side of
                                                the Moon (1973)/04. Time
                                            </div>
                                            <div>
                                                <code className="text-white/50">
                                                    {
                                                        "{item.artist} - {item.title}"
                                                    }
                                                </code>
                                            </div>
                                            <div className="pl-3 text-white/40">
                                                → Pink Floyd - Time (flat, no
                                                folders)
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </details>
                        </div>
                    }
                >
                    <SettingsInput
                        value={
                            settings.tidalFileTemplate ||
                            "{album.artist}/{album.title}/{item.number:02d}. {item.title}"
                        }
                        onChange={(v) => onUpdate({ tidalFileTemplate: v })}
                        placeholder="{album.artist}/{album.title}/{item.number:02d}. {item.title}"
                        className="w-full max-w-md font-mono text-xs"
                    />
                </SettingsRow>

                {/* Test connection */}
                <div className="pt-2 space-y-2">
                    <div className="inline-flex items-center gap-3">
                        <button
                            onClick={handleTest}
                            disabled={isTesting || !isAuthenticated}
                            className="px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full
                                hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                        >
                            {testStatus === "loading"
                                ? "Testing..."
                                : "Test Connection"}
                        </button>
                        <InlineStatus
                            status={testStatus}
                            message={testMessage}
                            onClear={reset}
                        />
                    </div>
                    <p className="text-xs text-white/40">
                        Downloads will be saved using your file naming template
                    </p>
                </div>
            </div>
        </IntegrationCard>
    );
}
