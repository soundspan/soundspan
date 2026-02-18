"use client";

import { useState, useEffect, useCallback } from "react";
import { SettingsSection, SettingsRow, SettingsToggle, SettingsSelect, SettingsInput, IntegrationCard } from "../ui";
import { UserSettings, SystemSettings } from "../../types";
import { api } from "@/lib/api";
import { CheckCircle, XCircle, Loader2, ExternalLink, Copy, AlertTriangle, Youtube } from "lucide-react";

// ── Admin Section: enable/disable toggle (system-wide) ─────────────

interface YouTubeMusicAdminSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

export function YouTubeMusicAdminSection({ settings, onUpdate }: YouTubeMusicAdminSectionProps) {
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
                description="Allow users to connect their own YouTube Music accounts for gap-fill streaming"
            >
                <SettingsToggle
                    checked={settings.ytMusicEnabled}
                    onChange={(v) => onUpdate({ ytMusicEnabled: v })}
                />
            </SettingsRow>

            {settings.ytMusicEnabled && (
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
        </SettingsSection>
    );
}

// ── User Section: per-user OAuth + quality settings ────────────────

interface YouTubeMusicCardProps {
    settings: UserSettings;
    onUpdate: (updates: Partial<UserSettings>) => void;
}

export function YouTubeMusicCard({ settings, onUpdate }: YouTubeMusicCardProps) {
    const [status, setStatus] = useState<{
        enabled: boolean;
        available: boolean;
        authenticated: boolean;
        credentialsConfigured: boolean;
    } | null>(null);
    const [statusLoading, setStatusLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Device code flow state
    const [deviceCode, setDeviceCode] = useState<string | null>(null);
    const [userCode, setUserCode] = useState<string | null>(null);
    const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
    const [linking, setLinking] = useState(false);
    const [polling, setPolling] = useState(false);
    const [copied, setCopied] = useState(false);
    const [expiresAt, setExpiresAt] = useState<number | null>(null);
    const [timeLeft, setTimeLeft] = useState<number | null>(null);

    // Check status on mount
    useEffect(() => {
        checkStatus();
    }, []);

    // Expiration countdown
    useEffect(() => {
        if (!expiresAt || !polling) {
            setTimeLeft(null);
            return;
        }

        const tick = () => {
            const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
            setTimeLeft(remaining);
            if (remaining <= 0) {
                // Device code expired — cancel the flow
                setPolling(false);
                setDeviceCode(null);
                setUserCode(null);
                setVerificationUrl(null);
                setExpiresAt(null);
                setError("The sign-in code has expired. Please try again.");
            }
        };

        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [expiresAt, polling]);

    // Polling effect — uses recursive setTimeout so the next poll only
    // starts after the previous one completes (prevents overlapping requests
    // that cause the device code to be consumed then re-used → invalid_grant)
    useEffect(() => {
        if (!polling || !deviceCode) return;

        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;

        const poll = async () => {
            if (cancelled) return;
            try {
                const result = await api.pollYtMusicAuth(deviceCode);
                if (cancelled) return;

                if (result.status === "success") {
                    setPolling(false);
                    setDeviceCode(null);
                    setUserCode(null);
                    setVerificationUrl(null);
                    setExpiresAt(null);
                    setSuccess("YouTube Music account connected successfully!");
                    setError(null);
                    await checkStatus();
                    return; // done — don't schedule another poll
                } else if (result.status === "error") {
                    setPolling(false);
                    setDeviceCode(null);
                    setUserCode(null);
                    setVerificationUrl(null);
                    setExpiresAt(null);
                    setError(result.error || "Authorization failed. Please try again.");
                    return; // done — don't schedule another poll
                }
                // "pending" — schedule next poll
            } catch (err: any) {
                // Don't stop polling on transient errors
                console.debug("Poll error (retrying):", err);
            }
            if (!cancelled) {
                timer = setTimeout(poll, 5000);
            }
        };

        // First poll after a 5-second delay
        timer = setTimeout(poll, 5000);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [polling, deviceCode]);

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

    const handleLinkAccount = async () => {
        setLinking(true);
        setError(null);
        setSuccess(null);

        try {
            const result = await api.initiateYtMusicAuth();
            setDeviceCode(result.device_code);
            setUserCode(result.user_code);
            setVerificationUrl(result.verification_url);
            setExpiresAt(Date.now() + result.expires_in * 1000);
            setPolling(true);

            // Copy code to clipboard so user can paste it on Google's page
            try {
                await navigator.clipboard.writeText(result.user_code);
                setCopied(true);
                setTimeout(() => setCopied(false), 3000);
            } catch {
                // Clipboard may not be available — user can copy manually
            }

            // Open the Google device code entry page (without ?user_code= which
            // adds an unnecessary confirmation step before the real entry page)
            window.open(result.verification_url, "_blank", "noopener,noreferrer");
        } catch (err: any) {
            setError(err.message || "Failed to start authentication. Check admin credentials.");
        } finally {
            setLinking(false);
        }
    };

    const handleCancelLink = () => {
        setPolling(false);
        setDeviceCode(null);
        setUserCode(null);
        setVerificationUrl(null);
        setExpiresAt(null);
        setError(null);
    };

    const handleClearAuth = async () => {
        try {
            await api.clearYtMusicAuth();
            setStatus(prev => prev ? { ...prev, authenticated: false } : prev);
            setSuccess(null);
            setError(null);
        } catch (err) {
            console.error("Failed to clear YouTube Music auth:", err);
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

    const formatTimeLeft = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    };

    const qualityOptions = [
        { value: "LOW", label: "Low (64 kbps)" },
        { value: "MEDIUM", label: "Medium (128 kbps)" },
        { value: "HIGH", label: "High (256 kbps)" },
        { value: "LOSSLESS", label: "Lossless (best available)" },
    ];

    // Derived card state
    const isConnected = !!status?.authenticated;
    const isDisabled = !!status && (!status.enabled || !status.available);
    const disabledReason = status && !status.enabled
        ? "Not enabled. Ask your administrator to enable it."
        : status && !status.available
          ? "YouTube Music service is not running"
          : undefined;
    const isExpanded = isConnected || !!userCode || polling
        || (!isConnected && !!status?.available && !status?.credentialsConfigured);

    const statusText = statusLoading
        ? "Checking..."
        : isConnected
          ? "Connected"
          : "Not connected";

    const statusColor: "green" | "red" | "gray" = statusLoading
        ? "gray"
        : isConnected
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
            icon={<Youtube className="w-5 h-5 text-red-500" />}
            title="YouTube Music"
            statusText={statusText}
            statusColor={statusColor}
            connected={isConnected}
            onConnect={status?.credentialsConfigured ? handleLinkAccount : undefined}
            onDisconnect={handleClearAuth}
            isLoading={statusLoading || linking}
            expanded={isExpanded}
            disabled={isDisabled}
            disabledReason={disabledReason}
            warning={warningBanner}
        >
            {/* Credentials not configured */}
            {!status?.credentialsConfigured && !isConnected && status?.available && (
                <p className="text-sm text-amber-400/70">
                    An administrator needs to configure YouTube Music OAuth credentials before you can connect.
                </p>
            )}

            {/* Device Code Auth Flow (not authenticated) */}
            {!isConnected && status?.available && status?.credentialsConfigured && (
                <div className="space-y-3">
                    {/* In linking flow — show device code + verification URL */}
                    {userCode && verificationUrl && polling && (
                        <div className="p-4 bg-[#252525] rounded-lg border border-[#333] space-y-4">
                            <div className="space-y-3">
                                <p className="text-sm text-gray-300">
                                    A Google sign-in page should have opened.
                                    If it didn&apos;t, click the link below.
                                </p>

                                {/* Step 1 — Paste code */}
                                <div className="flex items-start gap-3">
                                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold mt-0.5">1</span>
                                    <div className="space-y-2">
                                        <p className="text-sm text-gray-300">
                                            Paste this code on the Google page
                                            <span className="text-gray-500 text-xs ml-1">(it&apos;s already on your clipboard)</span>
                                        </p>
                                        <div className="flex items-center gap-3">
                                            <code className="px-4 py-2 text-lg font-mono font-bold tracking-wider bg-[#1a1a1a] text-white rounded-lg border border-[#444] select-all">
                                                {userCode}
                                            </code>
                                            <button
                                                onClick={handleCopyCode}
                                                className="p-2 text-gray-400 hover:text-white transition-colors"
                                                title="Copy code"
                                            >
                                                {copied ? (
                                                    <CheckCircle className="w-4 h-4 text-green-400" />
                                                ) : (
                                                    <Copy className="w-4 h-4" />
                                                )}
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/* Step 2 — Sign in */}
                                <div className="flex items-start gap-3">
                                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold mt-0.5">2</span>
                                    <p className="text-sm text-gray-300">
                                        Sign in with your Google account and click <strong className="text-white">Allow</strong>
                                    </p>
                                </div>

                                {/* Step 3 — Come back */}
                                <div className="flex items-start gap-3">
                                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold mt-0.5">3</span>
                                    <p className="text-sm text-gray-300">
                                        Return here — this page will update automatically
                                    </p>
                                </div>
                            </div>

                            <a
                                href={verificationUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-blue-600/20 text-blue-400 rounded-full
                                    hover:bg-blue-600/30 border border-blue-500/30 transition-colors"
                            >
                                <ExternalLink className="w-4 h-4" />
                                Open Google Sign-In Page
                            </a>

                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-sm text-gray-400">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    <span>Waiting for you to complete sign-in...</span>
                                </div>
                                {timeLeft !== null && (
                                    <span className={`text-xs tabular-nums ${
                                        timeLeft < 120 ? "text-amber-400/70" : "text-gray-500"
                                    }`}>
                                        Expires in {formatTimeLeft(timeLeft)}
                                    </span>
                                )}
                            </div>

                            <button
                                onClick={handleCancelLink}
                                className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    )}

                    {error && (
                        <div className="flex items-start gap-2 text-sm text-red-400">
                            <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                            <span>{error}</span>
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
