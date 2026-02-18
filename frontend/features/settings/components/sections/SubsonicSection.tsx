"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { api } from "@/lib/api";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { SettingsInput, SettingsRow } from "../ui";
import { BRAND_NAME } from "@/lib/brand";

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/**
 * Subsonic password row — rendered inside AccountSection.
 * Self-contained state management, no SettingsSection wrapper.
 */
export function SubsonicRows() {
    const [password, setPassword] = useState("");
    const [hasPassword, setHasPassword] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [status, setStatus] = useState<StatusType>("idle");
    const [message, setMessage] = useState("");
    const [showTooltip, setShowTooltip] = useState(false);

    useEffect(() => {
        const loadStatus = async () => {
            try {
                const result = await api.getSubsonicPasswordStatus();
                setHasPassword(result.hasPassword);
            } catch {
                // No-op: preserve settings page rendering even if endpoint is unavailable.
            }
        };

        loadStatus();
    }, []);

    const handleSave = async () => {
        if (!password.trim()) {
            setStatus("error");
            setMessage("Password is required");
            return;
        }

        if (password.length < MIN_PASSWORD_LENGTH) {
            setStatus("error");
            setMessage(`Minimum ${MIN_PASSWORD_LENGTH} characters`);
            return;
        }

        if (password.length > MAX_PASSWORD_LENGTH) {
            setStatus("error");
            setMessage(`Maximum ${MAX_PASSWORD_LENGTH} characters`);
            return;
        }

        setIsSaving(true);
        setStatus("loading");

        try {
            await api.setSubsonicPassword(password);
            setHasPassword(true);
            setPassword("");
            setIsEditing(false);
            setStatus("success");
            setMessage("Saved");
        } catch (error) {
            setStatus("error");
            setMessage(error instanceof Error ? error.message : "Failed");
        } finally {
            setIsSaving(false);
        }
    };

    const handleClear = async () => {
        setIsSaving(true);
        setStatus("loading");

        try {
            await api.clearSubsonicPassword();
            setHasPassword(false);
            setPassword("");
            setIsEditing(false);
            setStatus("success");
            setMessage("Cleared");
        } catch {
            setStatus("error");
            setMessage("Failed");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <SettingsRow
            label="Subsonic Password"
            align="start"
            labelExtra={
                <span className="relative inline-flex">
                    <button
                        type="button"
                        onMouseEnter={() => setShowTooltip(true)}
                        onMouseLeave={() => setShowTooltip(false)}
                        onClick={() => setShowTooltip((current) => !current)}
                        className="inline-flex items-center rounded p-0.5 text-gray-400 hover:text-white transition-colors"
                        aria-label="Subsonic password info"
                        title="Subsonic password info"
                    >
                        <Info className="h-3.5 w-3.5" />
                    </button>
                    {showTooltip && (
                        <span className="absolute left-0 top-full z-30 mt-1 w-72 rounded-md border border-white/15 bg-[#141414] p-2 text-[11px] leading-relaxed text-gray-300 shadow-2xl">
                            Using an app password is recommended so you do not share your main
                            {BRAND_NAME} login with third-party clients. If a device is lost, you can
                            rotate this password without changing your main account password.
                        </span>
                    )}
                </span>
            }
            description={
                hasPassword && !isEditing
                    ? "App password configured. Change or clear it any time."
                    : `If unset, Subsonic apps can still use your normal ${BRAND_NAME} username and password.`
            }
            htmlFor="subsonic-password"
        >
            <div className="flex flex-col items-end gap-2">
                {hasPassword && !isEditing ? (
                    <>
                        <input
                            id="subsonic-password"
                            type="text"
                            value="••••••••"
                            disabled
                            className="w-56 bg-[#333] text-white text-sm px-3 py-2 rounded-md border-0 outline-none opacity-50 cursor-not-allowed"
                        />
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setIsEditing(true)}
                                className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                            >
                                Change
                            </button>
                            <button
                                onClick={handleClear}
                                disabled={isSaving}
                                className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50"
                            >
                                Clear
                            </button>
                        </div>
                    </>
                ) : (
                    <>
                        <SettingsInput
                            id="subsonic-password"
                            type="password"
                            value={password}
                            onChange={setPassword}
                            placeholder="Enter Subsonic password"
                            className="w-56"
                        />
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleSave}
                                disabled={!password.trim() || isSaving}
                                className="px-4 py-2 text-sm bg-white text-black rounded-md font-medium hover:bg-gray-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isSaving ? "Saving..." : "Save"}
                            </button>
                            {hasPassword && (
                                <button
                                    onClick={() => {
                                        setIsEditing(false);
                                        setPassword("");
                                    }}
                                    className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                                >
                                    Cancel
                                </button>
                            )}
                        </div>
                    </>
                )}
                <InlineStatus
                    status={status}
                    message={message}
                    onClear={() => setStatus("idle")}
                />
            </div>
        </SettingsRow>
    );
}
