"use client";

import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { TwoFactorInput } from "./TwoFactorInput";

/** Props for the OIDC existing-account confirmation form. */
export interface OidcLinkFormProps {
    linkToken: string;
    onAuthenticated: () => void;
}

/** Confirms an email-matched account with its local password and optional 2FA. */
export function OidcLinkForm({
    linkToken,
    onAuthenticated,
}: OidcLinkFormProps) {
    const [password, setPassword] = useState("");
    const [twoFactorToken, setTwoFactorToken] = useState("");
    const [requires2FA, setRequires2FA] = useState(false);
    const [useRecoveryCode, setUseRecoveryCode] = useState(false);
    const [error, setError] = useState("");
    const [isLoading, setIsLoading] = useState(false);

    const handleSubmit = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        setError("");
        setIsLoading(true);
        try {
            const result = await api.confirmOidcLink({
                linkToken,
                password,
                twoFactorToken: requires2FA ? twoFactorToken : undefined,
            });
            if ("requires2FA" in result) {
                setRequires2FA(true);
                return;
            }
            onAuthenticated();
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Unable to link the SSO account",
            );
            setTwoFactorToken("");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-sm text-white/70">
                An account with this email already exists — sign in with your
                soundspan password to link it.
            </p>
            {error && (
                <div
                    role="alert"
                    className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-sm text-red-400"
                >
                    {error}
                </div>
            )}
            {!requires2FA ? (
                <div>
                    <label
                        htmlFor="oidcLinkPassword"
                        className="block text-sm font-medium text-white/90 mb-1.5"
                    >
                        Password
                    </label>
                    <input
                        id="oidcLinkPassword"
                        type="password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                        autoFocus
                        autoCapitalize="none"
                        autoCorrect="off"
                        className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-brand/30"
                    />
                </div>
            ) : (
                <TwoFactorInput
                    id="oidcLinkTwoFactorToken"
                    value={twoFactorToken}
                    useRecoveryCode={useRecoveryCode}
                    onValueChange={setTwoFactorToken}
                    onRecoveryCodeChange={setUseRecoveryCode}
                />
            )}
            <button
                type="submit"
                disabled={isLoading}
                className="w-full py-3 bg-brand text-black font-bold rounded-lg hover:bg-brand-dark disabled:opacity-50"
            >
                {isLoading && (
                    <Loader2 className="inline w-5 h-5 mr-2 animate-spin" />
                )}
                {requires2FA
                    ? "Verify and sign in"
                    : "Link account and sign in"}
            </button>
        </form>
    );
}
