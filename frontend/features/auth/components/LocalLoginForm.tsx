"use client";

import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { TwoFactorInput } from "./TwoFactorInput";

function isSecondFactorRequired(message: string): boolean {
    return (
        message.includes("2FA token required") ||
        message.includes("requires2FA")
    );
}

function isSecondFactorError(message: string): boolean {
    return (
        message.includes("Invalid 2FA token") ||
        message.includes("Invalid recovery code")
    );
}

function useLocalLoginForm() {
    const { login } = useAuth();
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [twoFactorToken, setTwoFactorToken] = useState("");
    const [requires2FA, setRequires2FA] = useState(false);
    const [useRecoveryCode, setUseRecoveryCode] = useState(false);
    const [error, setError] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const resetSecondFactor = (): void => {
        setRequires2FA(false);
        setTwoFactorToken("");
        setUseRecoveryCode(false);
        setError("");
    };
    const handleFailure = (caught: unknown): void => {
        const message =
            caught instanceof Error ? caught.message : "Login failed";
        if (isSecondFactorRequired(message)) {
            setRequires2FA(true);
            setError("");
            return;
        }
        setError(message);
        setTwoFactorToken("");
        if (!isSecondFactorError(message)) setRequires2FA(false);
    };
    const handleSubmit = async (event: FormEvent): Promise<void> => {
        event.preventDefault();
        setError("");
        setIsLoading(true);
        try {
            await login(
                username,
                password,
                requires2FA ? twoFactorToken : undefined,
            );
        } catch (caught) {
            handleFailure(caught);
        } finally {
            setIsLoading(false);
        }
    };
    return {
        username,
        password,
        twoFactorToken,
        requires2FA,
        useRecoveryCode,
        error,
        isLoading,
        setUsername,
        setPassword,
        setTwoFactorToken,
        setUseRecoveryCode,
        resetSecondFactor,
        handleSubmit,
    };
}

type LocalLoginFormState = ReturnType<typeof useLocalLoginForm>;

/** Renders the existing username/password login and local 2FA flow. */
export function LocalLoginForm() {
    const form = useLocalLoginForm();
    return (
        <form onSubmit={form.handleSubmit} className="space-y-4">
            <LoginError message={form.error} />
            {form.requires2FA ? (
                <LocalSecondFactor form={form} />
            ) : (
                <LocalCredentialFields form={form} />
            )}
            <SubmitButton isLoading={form.isLoading} />
            {form.requires2FA && (
                <button
                    type="button"
                    onClick={form.resetSecondFactor}
                    className="w-full text-xs text-white/50 hover:text-white/80 transition-colors"
                >
                    ← Back to login
                </button>
            )}
        </form>
    );
}

function LoginError({ message }: { message: string }) {
    if (!message) return null;
    return (
        <div
            role="alert"
            className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-sm text-red-400 animate-shake"
        >
            {message}
        </div>
    );
}

function LocalSecondFactor({ form }: { form: LocalLoginFormState }) {
    return (
        <div className="animate-fade-in space-y-4">
            <div className="p-4 bg-brand/10 border border-brand/20 rounded-lg">
                <p className="text-white/90 text-sm font-semibold mb-1">
                    Two-Factor Authentication Required
                </p>
                <p className="text-white/60 text-xs">
                    Logging in as <strong>{form.username}</strong>
                </p>
            </div>
            <TwoFactorInput
                id="twoFactorToken"
                value={form.twoFactorToken}
                useRecoveryCode={form.useRecoveryCode}
                onValueChange={form.setTwoFactorToken}
                onRecoveryCodeChange={form.setUseRecoveryCode}
            />
        </div>
    );
}

function LocalCredentialFields({ form }: { form: LocalLoginFormState }) {
    return (
        <>
            <CredentialInput
                id="username"
                label="Username or Email"
                type="text"
                value={form.username}
                onChange={form.setUsername}
                placeholder="Enter your username or email"
                autoFocus
            />
            <CredentialInput
                id="password"
                label="Password"
                type="password"
                value={form.password}
                onChange={form.setPassword}
                placeholder="Enter your password"
            />
        </>
    );
}

interface CredentialInputProps {
    id: string;
    label: string;
    type: "text" | "password";
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    autoFocus?: boolean;
}

function CredentialInput(props: CredentialInputProps) {
    return (
        <div>
            <label
                htmlFor={props.id}
                className="block text-sm font-medium text-white/90 mb-1.5"
            >
                {props.label}
            </label>
            <input
                id={props.id}
                type={props.type}
                value={props.value}
                onChange={(event) => props.onChange(event.target.value)}
                placeholder={props.placeholder}
                required
                autoFocus={props.autoFocus}
                autoCapitalize="none"
                autoCorrect="off"
                className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all duration-200"
            />
        </div>
    );
}

function SubmitButton({ isLoading }: { isLoading: boolean }) {
    return (
        <button
            type="submit"
            disabled={isLoading}
            className="w-full py-3 bg-brand text-black font-bold rounded-lg hover:bg-brand-dark transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
            <span className="flex items-center justify-center gap-2">
                {isLoading ? (
                    <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Signing in...
                    </>
                ) : (
                    "Sign In"
                )}
            </span>
        </button>
    );
}
