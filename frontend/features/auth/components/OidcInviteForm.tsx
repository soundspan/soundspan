"use client";

import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";

/** Props for the OIDC invite-code provisioning form. */
export interface OidcInviteFormProps {
    inviteToken: string;
    onAuthenticated: () => void;
}

function useOidcInviteForm({
    inviteToken,
    onAuthenticated,
}: OidcInviteFormProps) {
    const [inviteCode, setInviteCode] = useState("");
    const [error, setError] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const handleSubmit = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        setError("");
        setIsLoading(true);
        try {
            await api.redeemOidcInvite({ inviteToken, inviteCode });
            onAuthenticated();
        } catch (caught) {
            setError(
                caught instanceof Error
                    ? caught.message
                    : "Unable to redeem the invite code",
            );
        } finally {
            setIsLoading(false);
        }
    };
    return { inviteCode, setInviteCode, error, isLoading, handleSubmit };
}

type OidcInviteFormState = ReturnType<typeof useOidcInviteForm>;

/** Collects an invite code before provisioning an OIDC-authenticated account. */
export function OidcInviteForm(props: OidcInviteFormProps) {
    const form = useOidcInviteForm(props);
    return (
        <form onSubmit={form.handleSubmit} className="space-y-4">
            <p className="text-sm text-white/70">
                No soundspan account is linked to this identity — enter an
                invite code to create one.
            </p>
            <InviteError message={form.error} />
            <InviteCodeField form={form} />
            <button
                type="submit"
                disabled={form.isLoading}
                className="w-full py-3 bg-brand text-black font-bold rounded-lg hover:bg-brand-dark disabled:opacity-50"
            >
                {form.isLoading && (
                    <Loader2 className="inline w-5 h-5 mr-2 animate-spin" />
                )}
                Create account and sign in
            </button>
        </form>
    );
}

function InviteError({ message }: { message: string }) {
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

function InviteCodeField({ form }: { form: OidcInviteFormState }) {
    return (
        <div>
            <label
                htmlFor="oidcInviteCode"
                className="block text-sm font-medium text-white/90 mb-1.5"
            >
                Invite Code
            </label>
            <input
                id="oidcInviteCode"
                type="text"
                value={form.inviteCode}
                onChange={(event) => form.setInviteCode(event.target.value)}
                required
                autoFocus
                autoCapitalize="characters"
                autoCorrect="off"
                className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-brand/30"
            />
        </div>
    );
}
