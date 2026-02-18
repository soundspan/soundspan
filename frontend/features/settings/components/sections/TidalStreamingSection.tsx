"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { SettingsRow, SettingsSelect, IntegrationCard } from "../ui";
import { UserSettings } from "../../types";
import { CheckCircle, XCircle, Loader2, ExternalLink, Copy, AlertTriangle, Music2 } from "lucide-react";
import { api } from "@/lib/api";

interface TidalStreamingCardProps {
    settings: UserSettings;
    onUpdate: (updates: Partial<UserSettings>) => void;
}

type AuthState = "idle" | "loading" | "polling" | "success" | "error";

const QUALITY_OPTIONS = [
    { value: "LOW", label: "Low (AAC 96 kbps)" },
    { value: "HIGH", label: "High (AAC 320 kbps)" },
    { value: "LOSSLESS", label: "Lossless (FLAC 16-bit / 44.1 kHz)" },
    { value: "HI_RES_LOSSLESS", label: "Max / Hi-Res (FLAC up to 24-bit / 192 kHz)" },
];

export function TidalStreamingCard({
    settings,
    onUpdate,
}: TidalStreamingCardProps) {
    // Service status
    const [tidalEnabled, setTidalEnabled] = useState(false);
    const [tidalAvailable, setTidalAvailable] = useState(false);
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [statusLoading, setStatusLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Device auth flow state
    const [authState, setAuthState] = useState<AuthState>("idle");
    const [authUrl, setAuthUrl] = useState("");
    const [userCode, setUserCode] = useState("");
    const [copied, setCopied] = useState(false);
    const [expiresAt, setExpiresAt] = useState<number | null>(null);
    const [timeLeft, setTimeLeft] = useState<number | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Check TIDAL streaming status on mount
    useEffect(() => {
        checkStatus();
    }, []);

    // Expiration countdown
    useEffect(() => {
        if (!expiresAt || authState !== "polling") {
            setTimeLeft(null);
            return;
        }

        const tick = () => {
            const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
            setTimeLeft(remaining);
            if (remaining <= 0) {
                handleCancelLink();
                setError("The sign-in code has expired. Please try again.");
            }
        };

        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [expiresAt, authState]);

    // Clean up polling on unmount
    useEffect(() => {
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, []);

    const checkStatus = useCallback(async () => {
        setStatusLoading(true);
        try {
            const status = await api.getTidalStreamingStatus();
            setTidalEnabled(status.enabled);
            setTidalAvailable(status.available);
            setIsAuthenticated(status.authenticated);
        } catch {
            // TIDAL streaming not available
        }
        setStatusLoading(false);
    }, []);

    const handleLinkAccount = useCallback(async () => {
        setAuthState("loading");
        setError(null);
        setSuccess(null);

        try {
            const deviceAuth = await api.initiateTidalAuth();

            // Ensure URL has protocol
            let authLink =
                deviceAuth.verification_uri_complete ||
                deviceAuth.verification_uri;
            if (authLink && !authLink.startsWith("http")) {
                authLink = `https://${authLink}`;
            }

            setAuthUrl(authLink);
            setUserCode(deviceAuth.user_code || "");
            setAuthState("polling");
            setExpiresAt(Date.now() + (deviceAuth.expires_in || 300) * 1000);

            // Copy code to clipboard
            try {
                await navigator.clipboard.writeText(deviceAuth.user_code || "");
                setCopied(true);
                setTimeout(() => setCopied(false), 3000);
            } catch {
                // Clipboard may not be available
            }

            // Open auth URL in new tab
            window.open(authLink, "_blank", "noopener,noreferrer");

            // Start polling for token
            const deviceCode = deviceAuth.device_code;
            const interval = (deviceAuth.interval || 5) * 1000;

            pollRef.current = setInterval(async () => {
                try {
                    const result = await api.pollTidalAuth(deviceCode);

                    if (result.status === "success") {
                        if (pollRef.current) clearInterval(pollRef.current);
                        setAuthState("success");
                        setUserCode("");
                        setAuthUrl("");
                        setExpiresAt(null);
                        setSuccess(`Connected as ${result.username || "TIDAL user"}`);
                        setError(null);
                        setIsAuthenticated(true);
                    } else if (result.status === "error") {
                        if (pollRef.current) clearInterval(pollRef.current);
                        setAuthState("error");
                        setUserCode("");
                        setAuthUrl("");
                        setExpiresAt(null);
                        setError(result.error || "Authentication failed");
                    }
                    // If status is "pending", keep polling
                } catch {
                    // Transient error — keep polling
                }
            }, interval);
        } catch (err: any) {
            setAuthState("error");
            setError(err.message || "Failed to start TIDAL auth");
        }
    }, []);

    const handleCancelLink = useCallback(() => {
        if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
        }
        setAuthState("idle");
        setUserCode("");
        setAuthUrl("");
        setExpiresAt(null);
        setError(null);
    }, []);

    const handleDisconnect = useCallback(async () => {
        try {
            await api.clearTidalStreamingAuth();
            setIsAuthenticated(false);
            setAuthState("idle");
            setSuccess(null);
            setError(null);
        } catch (err: any) {
            setError(err.message || "Failed to disconnect");
        }
    }, []);

    const handleCopyCode = useCallback(async () => {
        if (!userCode) return;
        try {
            await navigator.clipboard.writeText(userCode);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            const textarea = document.createElement("textarea");
            textarea.value = userCode;
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            document.body.removeChild(textarea);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        }
    }, [userCode]);

    const formatTimeLeft = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    };

    // Derived card state
    const isDisabled = !statusLoading && (!tidalEnabled || !tidalAvailable);
    const disabledReason = !tidalEnabled
        ? "Not enabled. Ask your administrator to enable it."
        : !tidalAvailable
          ? "TIDAL service is not running"
          : undefined;
    const isExpanded = isAuthenticated || authState === "polling" || authState === "loading";

    const statusText = statusLoading
        ? "Checking..."
        : isAuthenticated
          ? "Connected"
          : "Not connected";

    const statusColor: "green" | "red" | "gray" = statusLoading
        ? "gray"
        : isAuthenticated
          ? "green"
          : "red";

    const warningBanner = (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-200/80">
                Not affiliated with or endorsed by TIDAL. Requires an active TIDAL subscription.
                You are responsible for complying with TIDAL&apos;s Terms of Service.
            </p>
        </div>
    );

    return (
        <IntegrationCard
            icon={<Music2 className="w-5 h-5 text-cyan-400" />}
            title="TIDAL"
            statusText={statusText}
            statusColor={statusColor}
            connected={isAuthenticated}
            onConnect={handleLinkAccount}
            onDisconnect={handleDisconnect}
            isLoading={statusLoading || authState === "loading"}
            expanded={isExpanded}
            disabled={isDisabled}
            disabledReason={disabledReason}
            warning={warningBanner}
        >
            {/* Device Code Auth Flow (not authenticated) */}
            {!isAuthenticated && tidalAvailable && (
                <div className="space-y-3">
                    {/* In linking flow — show device code + verification URL */}
                    {userCode && authState === "polling" && (
                        <div className="p-4 bg-[#252525] rounded-lg border border-[#333] space-y-4">
                            <div className="space-y-3">
                                <p className="text-sm text-gray-300">
                                    A TIDAL authorization page should have opened.
                                    If it didn&apos;t, click the link below.
                                </p>

                                {/* Step 1 — Paste code */}
                                <div className="flex items-start gap-3">
                                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold mt-0.5">1</span>
                                    <div className="space-y-2">
                                        <p className="text-sm text-gray-300">
                                            Enter this code on the TIDAL page
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
                                        Sign in with your TIDAL account and click <strong className="text-white">Allow</strong>
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

                            {authUrl && (
                                <a
                                    href={authUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-blue-600/20 text-blue-400 rounded-full
                                        hover:bg-blue-600/30 border border-blue-500/30 transition-colors"
                                >
                                    <ExternalLink className="w-4 h-4" />
                                    Open TIDAL Authorization Page
                                </a>
                            )}

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
            {isAuthenticated && success && (
                <div className="flex items-center gap-2 text-sm text-green-400 mb-2">
                    <CheckCircle className="w-4 h-4 flex-shrink-0" />
                    <span>{success}</span>
                </div>
            )}

            {/* Streaming Quality */}
            {isAuthenticated && (
                <SettingsRow
                    label="Streaming Quality"
                    description="Audio quality for TIDAL streaming (requires matching subscription)"
                >
                    <SettingsSelect
                        value={settings.tidalStreamingQuality || "HIGH"}
                        onChange={(v) =>
                            onUpdate({
                                tidalStreamingQuality:
                                    v as UserSettings["tidalStreamingQuality"],
                            })
                        }
                        options={QUALITY_OPTIONS}
                    />
                </SettingsRow>
            )}
        </IntegrationCard>
    );
}
