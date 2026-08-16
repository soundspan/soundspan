"use client";

/** Props for the full-page OIDC navigation button. */
export interface SsoButtonProps {
    providerName: string;
    onClick: () => void;
}

/** Starts a full-page sign-in navigation to the configured OIDC provider. */
export function SsoButton({ providerName, onClick }: SsoButtonProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="w-full py-3 border border-white/20 text-white font-semibold rounded-lg hover:bg-white/10 transition-colors"
        >
            Sign in with {providerName}
        </button>
    );
}
