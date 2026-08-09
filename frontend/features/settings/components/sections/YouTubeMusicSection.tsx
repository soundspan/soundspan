"use client";

import { useState, useEffect, useCallback } from "react";
import { DeviceAuthLinkPanel, SettingsSection, SettingsRow, SettingsToggle, SettingsSelect, SettingsInput, IntegrationCard } from "../ui";
import { UserSettings, SystemSettings } from "../../types";
import { api } from "@/lib/api";
import { createFrontendLogger } from "@/lib/logger";
import { useDeviceAuthPolling } from "@/hooks/useDeviceAuthPolling";
// lucide-react 1.x removed brand icons (Youtube included); SquarePlay is the closest generic stand-in.
import { CheckCircle, XCircle, AlertTriangle, SquarePlay, ChevronDown, ChevronRight } from "lucide-react";

const logger = createFrontendLogger("Settings.YouTubeMusicSection");

// ── Admin Section: enable/disable toggle (system-wide) ─────────────

interface YouTubeMusicAdminSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

/**
 * Renders the YouTubeMusicAdminSection component.
 */
export function YouTubeMusicAdminSection({ settings, onUpdate }: YouTubeMusicAdminSectionProps) {
    const [oauthExpanded, setOauthExpanded] = useState(
        !!(settings.ytMusicClientId || settings.ytMusicClientSecret)
    );

    return (
        <SettingsSection
            id="youtube-music-admin"
            title="YouTube Music"
            description="Enable or disable YouTube Music integration for all users"
        >
            <div className="mx-4 mt-3 mb-1 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <p className="text-xs text-amber-200/80">
                    This integration uses unofficial libraries and is not affiliated with or endorsed by Google or YouTube.
                    A YouTube Music Premium subscription is required. Users are responsible for ensuring their use complies
                    with YouTube&apos;s Terms of Service.
                </p>
            </div>
            <SettingsRow
                label="Enable YouTube Music"
                description="Enable YouTube Music search, browse, and streaming for all users"
            >
                <SettingsToggle
                    checked={settings.ytMusicEnabled}
                    onChange={(v) => onUpdate({ ytMusicEnabled: v })}
                />
            </SettingsRow>

            {settings.ytMusicEnabled && (
                <div className="mx-4 mb-2">
                    <button
                        onClick={() => setOauthExpanded(!oauthExpanded)}
                        className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 transition-colors py-2"
                    >
                        {oauthExpanded
                            ? <ChevronDown className="w-4 h-4" />
                            : <ChevronRight className="w-4 h-4" />
                        }
                        <span>Account Linking (Optional)</span>
                    </button>
                    <p className="text-xs text-gray-400 ml-6 mb-2">
                        Configure Google OAuth credentials to allow users to link their personal YouTube Music
                        accounts for library access. Not required for search, browse, or streaming.
                    </p>
                    {oauthExpanded && (
                        <>
                            <SettingsRow
                                label="Client ID"
                                description={
                                    <>
                                        Google OAuth client ID (
                                        <a
                                            href="https://console.cloud.google.com/apis/credentials"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-blue-400 hover:underline"
                                        >
                                            create one here
                                        </a>
                                        {" "}— select &quot;TVs and Limited Input devices&quot;)
                                    </>
                                }
                            >
                                <SettingsInput
                                    value={settings.ytMusicClientId || ""}
                                    onChange={(v) => onUpdate({ ytMusicClientId: v })}
                                    placeholder="Enter Client ID"
                                    className="w-64"
                                />
                            </SettingsRow>

                            <SettingsRow
                                label="Client Secret"
                                description="Corresponding client secret for the OAuth app"
                            >
                                <SettingsInput
                                    type="password"
                                    value={settings.ytMusicClientSecret || ""}
                                    onChange={(v) => onUpdate({ ytMusicClientSecret: v })}
                                    placeholder="Enter Client Secret"
                                    className="w-64"
                                />
                            </SettingsRow>
                        </>
                    )}
                </div>
            )}
        </SettingsSection>
    );
}

// ── User Section: per-user OAuth + quality settings ────────────────

interface YouTubeMusicCardProps {
    settings: UserSettings;
    onUpdate: (updates: Partial<UserSettings>) => void;
}

/**
 * Renders the YouTubeMusicCard component.
 */
export function YouTubeMusicCard({ settings, onUpdate }: YouTubeMusicCardProps) {
    const [status, setStatus] = useState<{
        enabled: boolean;
        available: boolean;
        authenticated: boolean;
        credentialsConfigured: boolean;
        oauthConfigured?: boolean;
    } | null>(null);
    const [statusLoading, setStatusLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const [copied, setCopied] = useState(false);

    const checkStatus = useCallback(async () => {
        setStatusLoading(true);
        try {
            const res = await api.getYtMusicStatus();
            setStatus(res);
        } catch (err) {
            setStatus({ enabled: false, available: false, authenticated: false, credentialsConfigured: false });
        } finally {
            setStatusLoading(false);
        }
    }, []);

    // Check status on mount
    useEffect(() => {
        void checkStatus();
    }, [checkStatus]);

    const initiateAuth = useCallback(async () => {
        const r = await api.initiateYtMusicAuth();
        return {
            deviceCode: r.device_code,
            verificationUri: r.verification_url,
            userCode: r.user_code,
            pollIntervalMs: (r.interval || 5) * 1000,
            expiresAtMs: Date.now() + r.expires_in * 1000,
        };
    }, []);

    const pollAuth = useCallback(async (deviceCode: string) => {
        const r = await api.pollYtMusicAuth(deviceCode);
        if (r.status === "success") return { status: "success" } as const;
        if (r.status === "error") {
            return {
                status: "error",
                message: r.error || "Authorization failed. Please try again.",
            } as const;
        }
        return { status: "pending" } as const;
    }, []);

    const handleSessionStarted = useCallback(async (session: {
        userCode?: string;
        verificationUri: string;
    }) => {
        try {
            await navigator.clipboard.writeText(session.userCode || "");
            setCopied(true);
            setTimeout(() => setCopied(false), 3000);
        } catch {
            // Clipboard is optional.
        }
        window.open(session.verificationUri, "_blank", "noopener,noreferrer");
    }, []);

    const handleAuthSuccess = useCallback(() => {
        setSuccess("YouTube Music account connected successfully!");
        setError(null);
        void checkStatus();
        window.dispatchEvent(new Event("ytmusic-auth-changed"));
    }, [checkStatus]);

    const {
        phase: authState,
        session: authSession,
        error: authError,
        timeLeftSeconds: timeLeft,
        start: startAuthentication,
        cancel: cancelAuthentication,
    } = useDeviceAuthPolling({
        initiate: initiateAuth,
        poll: pollAuth,
        onSessionStarted: handleSessionStarted,
        onSuccess: handleAuthSuccess,
        expiredMessage: "The sign-in code has expired. Please try again.",
        startErrorMessage: "Failed to start authentication. Check admin credentials.",
    });
    const userCode = authSession?.userCode || "";
    const verificationUrl = authSession?.verificationUri || "";
    const polling = authState === "polling";

    const handleLinkAccount = useCallback(async () => {
        setError(null);
        setSuccess(null);
        await startAuthentication();
    }, [startAuthentication]);

    const handleCancelLink = useCallback(() => {
        cancelAuthentication();
        setError(null);
    }, [cancelAuthentication]);

    const handleClearAuth = async () => {
        try {
            await api.clearYtMusicAuth();
            setStatus(prev => prev ? { ...prev, authenticated: false } : prev);
            setSuccess(null);
            setError(null);
            window.dispatchEvent(new Event("ytmusic-auth-changed"));
        } catch (err) {
            logger.error("Failed to clear YouTube Music auth", { error: err });
        }
    };

    const handleCopyCode = async () => {
        if (!userCode) return;
        try {
            await navigator.clipboard.writeText(userCode);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Fallback for non-secure contexts
            const textarea = document.createElement("textarea");
            textarea.value = userCode;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    };

    const qualityOptions = [
        { value: "LOW", label: "Low (64 kbps)" },
        { value: "MEDIUM", label: "Medium (128 kbps)" },
        { value: "HIGH", label: "High (256 kbps)" },
        { value: "LOSSLESS", label: "Lossless (best available)" },
    ];

    // Derived card state
    const isConnected = !!status?.authenticated;
    const isActive = !!status?.enabled && !!status?.available;
    const canLinkAccount = !!(status?.oauthConfigured ?? status?.credentialsConfigured);
    const isDisabled = !!status && (!status.enabled || !status.available);
    const disabledReason = status && !status.enabled
        ? "Not enabled. Ask your administrator to enable it."
        : status && !status.available
          ? "YouTube Music service is not running"
          : undefined;
    // Always expanded so the Explore toggle remains accessible after disconnect
    const isExpanded = true;

    const statusText = statusLoading
        ? "Checking..."
        : isConnected
          ? "Connected"
          : isActive
            ? "Active"
            : "Not connected";

    const statusColor: "green" | "red" | "gray" = statusLoading
        ? "gray"
        : isDisabled
          ? "red"
          : isConnected || isActive
            ? "green"
            : "red";

    const warningBanner = (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-200/80">
                Not affiliated with or endorsed by Google. Requires a YouTube Music Premium subscription.
                You are responsible for complying with YouTube&apos;s Terms of Service.
            </p>
        </div>
    );

    return (
        <IntegrationCard
            icon={<SquarePlay className="w-5 h-5 text-red-500" />}
            title="YouTube Music"
            statusText={statusText}
            statusColor={statusColor}
            connected={isConnected}
            onConnect={canLinkAccount ? handleLinkAccount : undefined}
            onDisconnect={handleClearAuth}
            isLoading={statusLoading || authState === "loading"}
            expanded={isExpanded}
            disabled={isDisabled}
            disabledReason={disabledReason}
            warning={warningBanner}
        >
            {/* Account linking hint when OAuth is available but not linked */}
            {!isConnected && canLinkAccount && status?.available && !polling && !authError && !error && !success && (
                <p className="text-sm text-gray-400">
                    Link your Google account for personal library access (optional).
                </p>
            )}

            {/* Device Code Auth Flow (not authenticated) */}
            {!isConnected && status?.available && canLinkAccount && (
                <div className="space-y-3">
                    {/* In linking flow — show device code + verification URL */}
                    {userCode && verificationUrl && polling && (
                        <DeviceAuthLinkPanel
                            userCode={userCode}
                            verificationUrl={verificationUrl}
                            timeLeftSeconds={timeLeft}
                            copied={copied}
                            onCopyCode={handleCopyCode}
                            onCancel={handleCancelLink}
                            introText="A Google sign-in page should have opened. If it didn't, click the link below."
                            pasteInstruction="Paste this code on the Google page"
                            signInInstruction={<>Sign in with your Google account and click <strong className="text-white">Allow</strong></>}
                            openLinkLabel="Open Google Sign-In Page"
                        />
                    )}

                    {(authError || error) && (
                        <div className="flex items-start gap-2 text-sm text-red-400">
                            <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            <span>{authError || error}</span>
                        </div>
                    )}

                    {success && (
                        <div className="flex items-center gap-2 text-sm text-green-400">
                            <CheckCircle className="w-4 h-4 flex-shrink-0" />
                            <span>{success}</span>
                        </div>
                    )}
                </div>
            )}

            {/* Success message (shown when already authenticated) */}
            {isConnected && success && (
                <div className="flex items-center gap-2 text-sm text-green-400 mb-2">
                    <CheckCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{success}</span>
                </div>
            )}

            {/* Explore Page Toggle */}
            <SettingsRow
                label="Show on Explore Page"
                description="Display YouTube Music shelves, charts, and moods on the Explore page"
            >
                <SettingsToggle
                    checked={settings.showYtMusicExplore}
                    onChange={(v) => onUpdate({ showYtMusicExplore: v })}
                />
            </SettingsRow>

            {/* Quality Selection */}
            {isConnected && (
                <SettingsRow
                    label="Streaming Quality"
                    description="Audio quality for YouTube Music streams"
                >
                    <SettingsSelect
                        value={settings.ytMusicQuality}
                        onChange={(v) =>
                            onUpdate({
                                ytMusicQuality: v as UserSettings["ytMusicQuality"],
                            })
                        }
                        options={qualityOptions}
                    />
                </SettingsRow>
            )}
        </IntegrationCard>
    );
}
