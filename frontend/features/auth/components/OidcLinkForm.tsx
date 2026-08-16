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

function useOidcLinkForm({ linkToken, onAuthenticated }: OidcLinkFormProps) {
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
    return {
        password,
        setPassword,
        twoFactorToken,
        setTwoFactorToken,
        requires2FA,
        useRecoveryCode,
        setUseRecoveryCode,
        error,
        isLoading,
        handleSubmit,
    };
}

type OidcLinkFormState = ReturnType<typeof useOidcLinkForm>;

/** Confirms an email-matched account with its local password and optional 2FA. */
export function OidcLinkForm(props: OidcLinkFormProps) {
    const form = useOidcLinkForm(props);
    return (
        <form onSubmit={form.handleSubmit} className="space-y-4">
            <p className="text-sm text-white/70">
                An account with this email already exists — sign in with your
                soundspan password to link it.
            </p>
            <LinkError message={form.error} />
            <OidcLinkCredentials form={form} />
            <OidcLinkSubmitButton form={form} />
        </form>
    );
}

function LinkError({ message }: { message: string }) {
    if (!message) return null;
    return (
        <div
            role="alert"
            className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-sm text-red-400"
        >
            {message}
        </div>
    );
}

function OidcLinkCredentials({ form }: { form: OidcLinkFormState }) {
    if (form.requires2FA) {
        return (
            <TwoFactorInput
                id="oidcLinkTwoFactorToken"
                value={form.twoFactorToken}
                useRecoveryCode={form.useRecoveryCode}
                onValueChange={form.setTwoFactorToken}
                onRecoveryCodeChange={form.setUseRecoveryCode}
            />
        );
    }
    return (
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
                value={form.password}
                onChange={(event) => form.setPassword(event.target.value)}
                required
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
        </div>
    );
}

function OidcLinkSubmitButton({ form }: { form: OidcLinkFormState }) {
    return (
        <button
            type="submit"
            disabled={form.isLoading}
            className="w-full py-3 bg-brand text-black font-bold rounded-lg hover:bg-brand-dark disabled:opacity-50"
        >
            {form.isLoading && (
                <Loader2 className="inline w-5 h-5 mr-2 animate-spin" />
            )}
            {form.requires2FA
                ? "Verify and sign in"
                : "Link account and sign in"}
        </button>
    );
}
