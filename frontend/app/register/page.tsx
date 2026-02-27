"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import Image from "next/image";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { GalaxyBackground } from "@/components/ui/GalaxyBackground";
import {
    BRAND_MARKETING_TAGLINE,
    BRAND_NAME,
    BRAND_NAME_TRADEMARK,
} from "@/lib/brand";

function InviteCodePrefill({
    setInviteCode,
}: {
    setInviteCode: (code: string) => void;
}) {
    const searchParams = useSearchParams();

    useEffect(() => {
        const code = searchParams.get("code");
        if (code) {
            setInviteCode(code.toUpperCase());
        }
    }, [searchParams, setInviteCode]);

    return null;
}

export default function RegisterPage() {
    const router = useRouter();
    const [inviteCode, setInviteCode] = useState("");
    const [username, setUsername] = useState("");
    const [displayName, setDisplayName] = useState("");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [error, setError] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [checkingStatus, setCheckingStatus] = useState(true);

    // If no users exist, redirect to onboarding (the canonical bootstrap flow)
    useEffect(() => {
        const checkStatus = async () => {
            try {
                const status = await api.get<{ hasAccount: boolean }>(
                    "/onboarding/status"
                );
                if (!status.hasAccount) {
                    router.replace("/onboarding");
                    return;
                }
            } catch {
                // If check fails, show register form (fail open)
            }
            setCheckingStatus(false);
        };
        checkStatus();
    }, [router]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (password !== confirmPassword) {
            setError("Passwords do not match");
            return;
        }

        setIsLoading(true);
        try {
            await api.register({
                inviteCode,
                username,
                displayName,
                password,
                confirmPassword,
                email,
            });
            router.push("/");
        } catch (err) {
            setError(
                err instanceof Error ? err.message : "Registration failed"
            );
        } finally {
            setIsLoading(false);
        }
    };

    if (checkingStatus) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-black">
                <Loader2 className="w-8 h-8 animate-spin text-white/60" />
            </div>
        );
    }

    return (
        <div className="min-h-screen w-full relative overflow-hidden">
            <Suspense fallback={null}>
                <InviteCodePrefill setInviteCode={setInviteCode} />
            </Suspense>

            {/* Background */}
            <div className="absolute inset-0 bg-[#000]">
                <div className="absolute inset-0 bg-gradient-to-br from-[#3b82f6]/5 via-transparent to-transparent" />
                <div className="opacity-[0.08]">
                    <GalaxyBackground
                        primaryColor="#3b82f6"
                        secondaryColor="#3b82f6"
                    />
                </div>
            </div>

            {/* Registration Form - Centered */}
            <div className="relative z-20 min-h-screen flex items-center justify-center p-4">
                <div className="w-full max-w-md">
                    {/* Logo */}
                    <div className="flex items-center justify-center mb-8">
                        <div className="relative flex gap-3 items-center group">
                            <div className="relative">
                                <div className="absolute inset-0 bg-white/10 blur-xl rounded-full group-hover:bg-white/20 transition-all duration-300" />
                                <Image
                                    src="/assets/images/soundspan.webp"
                                    alt={BRAND_NAME}
                                    width={60}
                                    height={60}
                                    sizes="60px"
                                    className="relative z-10 drop-shadow-2xl"
                                />
                            </div>
                            <span className="brand-wordmark text-5xl font-bold bg-gradient-to-r from-white via-white to-gray-200 bg-clip-text text-transparent drop-shadow-2xl">
                                {BRAND_NAME_TRADEMARK}
                            </span>
                        </div>
                    </div>

                    {/* Registration Card */}
                    <div className="bg-[#111]/90 rounded-lg p-6 md:p-8 border border-white/10 shadow-xl">
                        <h1 className="text-2xl font-bold text-white mb-1 text-center">
                            Create your account
                        </h1>
                        <p className="text-white/60 text-center mb-8">
                            Join {BRAND_NAME} with an invite code
                        </p>

                        <form onSubmit={handleSubmit} className="space-y-4">
                            {error && (
                                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-sm text-red-400 animate-shake">
                                    {error}
                                </div>
                            )}

                            <div>
                                <label
                                    htmlFor="inviteCode"
                                    className="block text-sm font-medium text-white/90 mb-1.5"
                                >
                                    Invite Code
                                </label>
                                <input
                                    id="inviteCode"
                                    type="text"
                                    value={inviteCode}
                                    onChange={(e) =>
                                        setInviteCode(
                                            e.target.value.toUpperCase()
                                        )
                                    }
                                    placeholder="ABCD1234"
                                    required
                                    autoFocus
                                    autoCapitalize="characters"
                                    autoCorrect="off"
                                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all duration-200 tracking-widest font-mono text-center"
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="username"
                                    className="block text-sm font-medium text-white/90 mb-1.5"
                                >
                                    Username
                                </label>
                                <input
                                    id="username"
                                    type="text"
                                    value={username}
                                    onChange={(e) =>
                                        setUsername(e.target.value)
                                    }
                                    placeholder="Choose a username"
                                    required
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all duration-200"
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="displayName"
                                    className="block text-sm font-medium text-white/90 mb-1.5"
                                >
                                    Display Name
                                </label>
                                <input
                                    id="displayName"
                                    type="text"
                                    value={displayName}
                                    onChange={(e) =>
                                        setDisplayName(e.target.value)
                                    }
                                    placeholder="Your display name"
                                    required
                                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all duration-200"
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="email"
                                    className="block text-sm font-medium text-white/90 mb-1.5"
                                >
                                    Email
                                </label>
                                <input
                                    id="email"
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="you@example.com"
                                    required
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all duration-200"
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="password"
                                    className="block text-sm font-medium text-white/90 mb-1.5"
                                >
                                    Password
                                </label>
                                <input
                                    id="password"
                                    type="password"
                                    value={password}
                                    onChange={(e) =>
                                        setPassword(e.target.value)
                                    }
                                    placeholder="At least 6 characters"
                                    required
                                    minLength={6}
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all duration-200"
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="confirmPassword"
                                    className="block text-sm font-medium text-white/90 mb-1.5"
                                >
                                    Confirm Password
                                </label>
                                <input
                                    id="confirmPassword"
                                    type="password"
                                    value={confirmPassword}
                                    onChange={(e) =>
                                        setConfirmPassword(e.target.value)
                                    }
                                    placeholder="Repeat your password"
                                    required
                                    minLength={6}
                                    autoCapitalize="none"
                                    autoCorrect="off"
                                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-transparent transition-all duration-200"
                                />
                            </div>

                            <button
                                type="submit"
                                disabled={isLoading}
                                className="w-full py-3 bg-[#3b82f6] text-black font-bold rounded-lg hover:bg-[#2563eb] transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <span className="flex items-center justify-center gap-2">
                                    {isLoading ? (
                                        <>
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                            Creating account...
                                        </>
                                    ) : (
                                        "Create Account"
                                    )}
                                </span>
                            </button>
                        </form>

                        <p className="text-center text-white/50 text-sm mt-6">
                            Already have an account?{" "}
                            <Link
                                href="/login"
                                className="text-[#3b82f6] hover:text-[#60a5fa] transition-colors"
                            >
                                Sign in
                            </Link>
                        </p>
                    </div>

                    {/* Footer */}
                    <p className="text-center text-white/40 text-sm mt-6">
                        &copy; 2025 {BRAND_NAME}. {BRAND_MARKETING_TAGLINE}
                    </p>
                </div>
            </div>
        </div>
    );
}
