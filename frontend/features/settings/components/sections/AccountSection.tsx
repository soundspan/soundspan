"use client";

import { useState, useEffect } from "react";
import { SettingsSection, SettingsRow, SettingsInput } from "../ui";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { useTwoFactor } from "../../hooks/useTwoFactor";
import { Modal } from "@/components/ui/Modal";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import Image from "next/image";
import { SubsonicRows } from "./SubsonicSection";
import { UserSettings } from "../../types";

interface AccountSectionProps {
    settings: UserSettings;
    onUpdate: (updates: Partial<UserSettings>) => void;
}

const displayNamePattern = /^[A-Za-z0-9 .-]+$/;

export function AccountSection({ settings, onUpdate }: AccountSectionProps) {
    const { user } = useAuth();
    
    // Password change state
    const [currentPassword, setCurrentPassword] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [changingPassword, setChangingPassword] = useState(false);
    const [showPasswordForm, setShowPasswordForm] = useState(false);
    const [passwordStatus, setPasswordStatus] = useState<StatusType>("idle");
    const [passwordMessage, setPasswordMessage] = useState("");
    
    // 2FA state
    const {
        twoFactorEnabled,
        settingUpTwoFactor,
        twoFactorQR,
        twoFactorSecret,
        recoveryCodes,
        showRecoveryCodes,
        load2FAStatus,
        setup2FA,
        enable2FA,
        disable2FA,
        cancel2FASetup,
        closeRecoveryCodes,
    } = useTwoFactor();
    
    const [twoFactorToken, setTwoFactorToken] = useState("");
    const [disablePassword, setDisablePassword] = useState("");
    const [disableToken, setDisableToken] = useState("");
    const [showDisableFlow, setShowDisableFlow] = useState(false);
    const [tfaStatus, setTfaStatus] = useState<StatusType>("idle");
    const [tfaMessage, setTfaMessage] = useState("");

    const displayName = settings.displayName || "";
    const trimmedDisplayName = displayName.trim();
    const isDisplayNameValid =
        trimmedDisplayName.length === 0 ||
        displayNamePattern.test(trimmedDisplayName);

    // Load 2FA status on mount
    useEffect(() => {
        load2FAStatus();
    }, [load2FAStatus]);

    // Handle password change
    const handleChangePassword = async () => {
        if (!currentPassword || !newPassword || !confirmPassword) {
            setPasswordStatus("error");
            setPasswordMessage("All fields required");
            return;
        }
        if (newPassword.length < 6) {
            setPasswordStatus("error");
            setPasswordMessage("Min 6 characters");
            return;
        }
        if (newPassword !== confirmPassword) {
            setPasswordStatus("error");
            setPasswordMessage("Passwords don't match");
            return;
        }

        setChangingPassword(true);
        setPasswordStatus("loading");
        try {
            await api.post("/auth/change-password", {
                currentPassword,
                newPassword,
            });
            setPasswordStatus("success");
            setPasswordMessage("Changed");
            setCurrentPassword("");
            setNewPassword("");
            setConfirmPassword("");
            setTimeout(() => setShowPasswordForm(false), 1500);
        } catch (error: unknown) {
            setPasswordStatus("error");
            setPasswordMessage(error instanceof Error ? error.message : "Failed");
        } finally {
            setChangingPassword(false);
        }
    };

    // Handle 2FA verification
    const handleVerify2FA = async () => {
        setTfaStatus("loading");
        try {
            await enable2FA(twoFactorToken);
            setTfaStatus("success");
            setTfaMessage("Enabled");
            setTwoFactorToken("");
        } catch (error: unknown) {
            setTfaStatus("error");
            setTfaMessage(error instanceof Error ? error.message : "Invalid code");
        }
    };

    // Handle 2FA disable
    const handleDisable2FA = async () => {
        setTfaStatus("loading");
        try {
            await disable2FA(disablePassword, disableToken);
            setTfaStatus("success");
            setTfaMessage("Disabled");
            setDisablePassword("");
            setDisableToken("");
            setShowDisableFlow(false);
        } catch (error: unknown) {
            setTfaStatus("error");
            setTfaMessage(error instanceof Error ? error.message : "Failed");
        }
    };

    return (
        <>
            <SettingsSection id="account" title="Account">
                {/* Display Name */}
                <SettingsRow
                    label="Display Name"
                    description="Optional name shown in supported user-facing areas. Max 80 characters."
                >
                    <div className="w-64">
                        <SettingsInput
                            id="display-name"
                            type="text"
                            value={displayName}
                            onChange={(value) => onUpdate({ displayName: value })}
                            placeholder="e.g. Jane or Jane Doe"
                        />
                        {!isDisplayNameValid && (
                            <p className="mt-1 text-xs text-red-400">
                                Use only letters, numbers, spaces, periods, and hyphens.
                            </p>
                        )}
                    </div>
                </SettingsRow>

                {/* Username Display */}
                <SettingsRow label="Username" description={`Logged in as ${user?.username}`}>
                    <span className="text-sm text-gray-400">{user?.role}</span>
                </SettingsRow>

                {/* Change Password */}
                <SettingsRow 
                    label="Password" 
                    description="Change your account password"
                >
                    {!showPasswordForm ? (
                        <button
                            onClick={() => setShowPasswordForm(true)}
                            className="text-sm text-white hover:underline"
                        >
                            Change
                        </button>
                    ) : (
                        <button
                            onClick={() => setShowPasswordForm(false)}
                            className="text-sm text-gray-400 hover:text-white"
                        >
                            Cancel
                        </button>
                    )}
                </SettingsRow>

                {showPasswordForm && (
                    <div className="py-4 space-y-3 border-t border-b border-white/5">
                        <SettingsInput
                            type="password"
                            value={currentPassword}
                            onChange={setCurrentPassword}
                            placeholder="Current password"
                        />
                        <SettingsInput
                            type="password"
                            value={newPassword}
                            onChange={setNewPassword}
                            placeholder="New password (min 6 characters)"
                        />
                        <SettingsInput
                            type="password"
                            value={confirmPassword}
                            onChange={setConfirmPassword}
                            placeholder="Confirm new password"
                        />
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleChangePassword}
                                disabled={changingPassword || !currentPassword || !newPassword || newPassword !== confirmPassword}
                                className="px-4 py-2 bg-white text-black text-sm font-medium rounded-full
                                    hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                            >
                                {changingPassword ? "Changing..." : "Change Password"}
                            </button>
                            <InlineStatus 
                                status={passwordStatus} 
                                message={passwordMessage}
                                onClear={() => setPasswordStatus("idle")}
                            />
                        </div>
                    </div>
                )}

                {/* Two-Factor Authentication */}
                <SettingsRow 
                    label="Two-factor authentication" 
                    description={twoFactorEnabled ? "Enabled" : "Add extra security to your account"}
                >
                    {!settingUpTwoFactor && !showDisableFlow && (
                        twoFactorEnabled ? (
                            <button
                                onClick={() => setShowDisableFlow(true)}
                                className="text-sm text-red-400 hover:text-red-300"
                            >
                                Disable
                            </button>
                        ) : (
                            <button
                                onClick={setup2FA}
                                className="text-sm text-white hover:underline"
                            >
                                Enable
                            </button>
                        )
                    )}
                </SettingsRow>

                {/* 2FA Setup Flow */}
                {settingUpTwoFactor && (
                    <div className="py-4 space-y-4 border-t border-b border-white/5">
                        <p className="text-sm text-gray-400">
                            Scan the QR code with your authenticator app, then enter the code below.
                        </p>
                        
                        {twoFactorQR && (
                            <div className="flex justify-center">
                                <div className="bg-white p-3 rounded-lg">
                                    <Image src={twoFactorQR} alt="2FA QR Code" width={160} height={160} sizes="160px" className="w-40 h-40" unoptimized />
                                </div>
                            </div>
                        )}
                        
                        {twoFactorSecret && (
                            <div className="text-center">
                                <p className="text-xs text-gray-500 mb-1">Manual entry code:</p>
                                <code className="text-sm text-white bg-[#282828] px-3 py-1 rounded font-mono">
                                    {twoFactorSecret}
                                </code>
                            </div>
                        )}
                        
                        <SettingsInput
                            type="text"
                            value={twoFactorToken}
                            onChange={(v) => setTwoFactorToken(v.replace(/\D/g, "").slice(0, 6))}
                            placeholder="Enter 6-digit code"
                        />
                        
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleVerify2FA}
                                disabled={twoFactorToken.length !== 6}
                                className="px-4 py-2 bg-white text-black text-sm font-medium rounded-full
                                    hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                            >
                                Verify
                            </button>
                            <button
                                onClick={() => { cancel2FASetup(); setTwoFactorToken(""); }}
                                className="px-4 py-2 text-sm text-gray-400 hover:text-white"
                            >
                                Cancel
                            </button>
                            <InlineStatus 
                                status={tfaStatus} 
                                message={tfaMessage}
                                onClear={() => setTfaStatus("idle")}
                            />
                        </div>
                    </div>
                )}

                {/* 2FA Disable Flow */}
                {showDisableFlow && (
                    <div className="py-4 space-y-3 border-t border-b border-white/5">
                        <p className="text-sm text-yellow-500">
                            Enter your password and current code to disable 2FA.
                        </p>
                        <SettingsInput
                            type="password"
                            value={disablePassword}
                            onChange={setDisablePassword}
                            placeholder="Password"
                        />
                        <SettingsInput
                            type="text"
                            value={disableToken}
                            onChange={(v) => setDisableToken(v.replace(/\D/g, "").slice(0, 6))}
                            placeholder="6-digit code"
                        />
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleDisable2FA}
                                disabled={!disablePassword || disableToken.length !== 6}
                                className="px-4 py-2 bg-red-500 text-white text-sm font-medium rounded-full
                                    hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                Disable 2FA
                            </button>
                            <button
                                onClick={() => { setShowDisableFlow(false); setDisablePassword(""); setDisableToken(""); }}
                                className="px-4 py-2 text-sm text-gray-400 hover:text-white"
                            >
                                Cancel
                            </button>
                            <InlineStatus
                                status={tfaStatus}
                                message={tfaMessage}
                                onClear={() => setTfaStatus("idle")}
                            />
                        </div>
                    </div>
                )}

                {/* Subsonic App Password */}
                <SubsonicRows />
            </SettingsSection>

            {/* Recovery Codes Modal */}
            <Modal isOpen={showRecoveryCodes} onClose={closeRecoveryCodes} title="Recovery Codes">
                <div className="space-y-4">
                    <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                        <p className="text-sm text-red-300">
                            Save these codes! You&apos;ll need them if you lose your authenticator.
                        </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        {recoveryCodes.map((code, i) => (
                            <code key={i} className="text-sm text-white bg-[#282828] px-3 py-2 rounded font-mono">
                                {code}
                            </code>
                        ))}
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={() => navigator.clipboard.writeText(recoveryCodes.join("\n"))}
                            className="px-4 py-2 bg-[#333] text-white text-sm rounded-full hover:bg-[#404040]"
                        >
                            Copy
                        </button>
                        <button
                            onClick={closeRecoveryCodes}
                            className="px-4 py-2 bg-white text-black text-sm font-medium rounded-full hover:scale-105 transition-transform"
                        >
                            Done
                        </button>
                    </div>
                </div>
            </Modal>
        </>
    );
}
