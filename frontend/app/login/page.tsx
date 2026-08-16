"use client";

import {
    Suspense,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { GalaxyBackground } from "@/components/ui/GalaxyBackground";
import { LocalLoginForm } from "@/features/auth/components/LocalLoginForm";
import { OidcInviteForm } from "@/features/auth/components/OidcInviteForm";
import { OidcLinkForm } from "@/features/auth/components/OidcLinkForm";
import { SsoButton } from "@/features/auth/components/SsoButton";
import {
    buildOidcLoginUrl,
    getSsoErrorMessage,
    normalizeLoginReturnTo,
} from "@/features/auth/oidc";
import { api } from "@/lib/api";
import type { AuthConfig } from "@/lib/api/auth";
import {
    BRAND_MARKETING_TAGLINE,
    BRAND_NAME,
    BRAND_NAME_TRADEMARK,
} from "@/lib/brand";
import { frontendLogger } from "@/lib/logger";

interface Artist {
    id: string;
    name: string;
    heroUrl: string | null;
    albumCount?: number;
}

interface LoginParameters {
    ssoCode: string | null;
    ssoLink: string | null;
    ssoInvite: string | null;
    ssoError: string | null;
    legacyError: string | null;
    returnTo: string;
    hasOidcCallback: boolean;
}

const loginLogger = frontendLogger.child("Login");
const AUTH_CONFIG_QUERY_KEY = ["auth", "config"] as const;
const ONBOARDING_QUERY_KEY = ["onboarding", "status"] as const;

function LoadingPage({ message }: { message?: string }) {
    return (
        <div
            role="status"
            className="min-h-screen flex flex-col gap-3 items-center justify-center bg-black text-white/70"
        >
            <Loader2 className="w-8 h-8 animate-spin" />
            {message && <p>{message}</p>}
        </div>
    );
}

function readLoginParameters(searchParams: URLSearchParams): LoginParameters {
    const ssoCode = searchParams.get("ssoCode");
    const ssoLink = searchParams.get("ssoLink");
    const ssoInvite = searchParams.get("ssoInvite");
    const ssoError = searchParams.get("ssoError");
    return {
        ssoCode,
        ssoLink,
        ssoInvite,
        ssoError,
        legacyError: searchParams.get("error"),
        returnTo: normalizeLoginReturnTo(searchParams.get("returnTo")),
        hasOidcCallback: Boolean(ssoCode || ssoLink || ssoInvite || ssoError),
    };
}

function stripQueryParameter(name: string): void {
    const url = new URL(window.location.href);
    url.searchParams.delete(name);
    const query = url.searchParams.toString();
    const nextUrl = `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
    window.history.replaceState({}, "", nextUrl);
}

function navigateToReturnTo(returnTo: string): void {
    window.location.assign(normalizeLoginReturnTo(returnTo));
}

function buildBrowserOidcLoginUrl(returnTo: string): string {
    return buildOidcLoginUrl(returnTo, {
        configuredApiUrl: process.env.NEXT_PUBLIC_API_URL,
        apiPathMode: process.env.NEXT_PUBLIC_API_PATH_MODE,
        browserLocation: window.location,
    });
}

function useLoginParameters(): LoginParameters {
    const searchParams = useSearchParams();
    const parameters = useMemo(
        () => readLoginParameters(new URLSearchParams(searchParams.toString())),
        [searchParams],
    );
    const [callbackPresentOnMount] = useState(parameters.hasOidcCallback);
    return {
        ...parameters,
        hasOidcCallback: callbackPresentOnMount || parameters.hasOidcCallback,
    };
}

function useLoginArtists(): { artists: Artist[]; currentIndex: number } {
    const [artists, setArtists] = useState<Artist[]>([]);
    const [currentIndex, setCurrentIndex] = useState(0);
    useEffect(() => {
        void api
            .getRecentlyListened(10)
            .then((data) => {
                const items = Array.isArray(data?.items) ? data.items : [];
                const available = items
                    .filter((item) => item.type === "artist")
                    .map((item) => ({
                        id: item.id || "",
                        name: item.name || "Unknown Artist",
                        heroUrl:
                            item.userHeroUrl ||
                            item.heroUrl ||
                            item.coverArt ||
                            null,
                        albumCount: item.albumCount,
                    }))
                    .filter((artist) => artist.id && artist.heroUrl);
                setArtists(available);
            })
            .catch(() => undefined);
    }, []);
    useEffect(() => {
        if (artists.length <= 1) return undefined;
        const interval = window.setInterval(() => {
            setCurrentIndex((index) => (index + 1) % artists.length);
        }, 5000);
        return () => window.clearInterval(interval);
    }, [artists.length]);
    return { artists, currentIndex };
}

function useCallbackError(
    parameters: LoginParameters,
): [string, (value: string) => void] {
    const [error, setError] = useState(() => {
        if (parameters.ssoError) return getSsoErrorMessage(parameters.ssoError);
        return parameters.legacyError || "";
    });
    useEffect(() => {
        if (parameters.ssoError) stripQueryParameter("ssoError");
    }, [parameters.ssoError]);
    return [error, setError];
}

interface CallbackExchangeState {
    failed: boolean;
    pending: boolean;
}

function useOidcCodeExchange(
    code: string | null,
    returnTo: string,
    setError: (message: string) => void,
): CallbackExchangeState {
    const startedCode = useRef<string | null>(null);
    const [state, setState] = useState<CallbackExchangeState>({
        failed: false,
        pending: Boolean(code),
    });
    useEffect(() => {
        if (!code || startedCode.current === code) return;
        startedCode.current = code;
        setState({ failed: false, pending: true });
        void api
            .exchangeOidcCode(code)
            .then(() => navigateToReturnTo(returnTo))
            .catch((caught) => {
                loginLogger.error("OIDC code exchange failed", {
                    error: caught,
                });
                setError(
                    caught instanceof Error
                        ? caught.message
                        : "Unable to complete SSO sign-in",
                );
                stripQueryParameter("ssoCode");
                setState({ failed: true, pending: false });
            });
    }, [code, returnTo, setError]);
    return state;
}

/** Renders the login route with local and OIDC authentication modes. */
function LoginPageContent() {
    const router = useRouter();
    const parameters = useLoginParameters();
    const [error, setError] = useCallbackError(parameters);
    const exchange = useOidcCodeExchange(
        parameters.ssoCode,
        parameters.returnTo,
        setError,
    );
    const { artists, currentIndex } = useLoginArtists();
    const authConfig = useQuery({
        queryKey: AUTH_CONFIG_QUERY_KEY,
        queryFn: () => api.getAuthConfig(),
        staleTime: Number.POSITIVE_INFINITY,
        retry: false,
    });
    const onboarding = useQuery({
        queryKey: ONBOARDING_QUERY_KEY,
        queryFn: () => api.getOnboardingStatus(),
        retry: false,
    });

    useEffect(() => {
        if (onboarding.data && !onboarding.data.hasAccount) {
            router.replace("/onboarding");
        }
    }, [onboarding.data, router]);

    if (authConfig.isPending || onboarding.isPending) return <LoadingPage />;
    if (authConfig.isError || !authConfig.data) {
        return <AuthConfigFailure onRetry={() => void authConfig.refetch()} />;
    }
    if (onboarding.data && !onboarding.data.hasAccount) return <LoadingPage />;

    return (
        <LoginScene artists={artists} currentIndex={currentIndex}>
            <LoginCard
                config={authConfig.data}
                parameters={parameters}
                exchange={exchange}
                error={error}
            />
        </LoginScene>
    );
}

function AuthConfigFailure({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="min-h-screen flex items-center justify-center bg-black p-4">
            <div className="max-w-md text-center text-white space-y-4">
                <p role="alert">Unable to load sign-in options.</p>
                <button
                    type="button"
                    onClick={onRetry}
                    className="px-4 py-2 rounded-lg bg-brand text-black font-semibold"
                >
                    Retry
                </button>
            </div>
        </div>
    );
}

interface LoginCardProps {
    config: AuthConfig;
    parameters: LoginParameters;
    exchange: CallbackExchangeState;
    error: string;
}

function LoginCard({ config, parameters, exchange, error }: LoginCardProps) {
    const startSso = (): void => {
        window.location.assign(buildBrowserOidcLoginUrl(parameters.returnTo));
    };
    const autoRedirect =
        !config.localLoginEnabled &&
        config.oidcEnabled &&
        !parameters.hasOidcCallback;

    useEffect(() => {
        if (autoRedirect) {
            window.location.assign(
                buildBrowserOidcLoginUrl(parameters.returnTo),
            );
        }
    }, [autoRedirect, parameters.returnTo]);

    const authenticated = (): void => navigateToReturnTo(parameters.returnTo);
    const flow = selectLoginFlow(
        config,
        parameters,
        exchange,
        autoRedirect,
        startSso,
        authenticated,
    );
    return (
        <div className="bg-[#111]/90 rounded-lg p-6 md:p-8 border border-white/10 shadow-xl">
            <h1 className="text-2xl font-bold text-white mb-1 text-center">
                Welcome back
            </h1>
            <p className="text-white/60 text-center mb-8">
                Sign in to continue to {BRAND_NAME}
            </p>
            {error && (
                <div
                    role="alert"
                    className="mb-4 bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-sm text-red-400 animate-shake"
                >
                    {error}
                </div>
            )}
            {flow}
            {config.localLoginEnabled &&
                !parameters.ssoLink &&
                !parameters.ssoInvite && (
                    <p className="text-center text-white/50 text-sm mt-6">
                        Have an invite code?{" "}
                        <Link
                            href="/register"
                            className="text-brand hover:text-brand-hover transition-colors"
                        >
                            Create an account
                        </Link>
                    </p>
                )}
        </div>
    );
}

function selectLoginFlow(
    config: AuthConfig,
    parameters: LoginParameters,
    exchange: CallbackExchangeState,
    autoRedirect: boolean,
    startSso: () => void,
    authenticated: () => void,
): ReactNode {
    if (parameters.ssoCode && !exchange.failed) {
        return <LoadingPageContent message="Completing SSO sign-in…" />;
    }
    if (parameters.ssoLink) {
        return (
            <OidcLinkForm
                linkToken={parameters.ssoLink}
                onAuthenticated={authenticated}
            />
        );
    }
    if (parameters.ssoInvite) {
        return (
            <OidcInviteForm
                inviteToken={parameters.ssoInvite}
                onAuthenticated={authenticated}
            />
        );
    }
    if (autoRedirect) {
        return (
            <RedirectingContent
                providerName={config.oidcProviderName}
                onClick={startSso}
            />
        );
    }
    return <DefaultLoginOptions config={config} onSsoClick={startSso} />;
}

function LoadingPageContent({ message }: { message: string }) {
    return (
        <div
            role="status"
            className="flex flex-col items-center gap-3 py-4 text-white/70"
        >
            <Loader2 className="w-6 h-6 animate-spin" />
            <p>{message}</p>
        </div>
    );
}

function RedirectingContent({
    providerName,
    onClick,
}: {
    providerName: string;
    onClick: () => void;
}) {
    return (
        <div className="space-y-4">
            <LoadingPageContent message="Redirecting to SSO…" />
            <SsoButton providerName={providerName} onClick={onClick} />
        </div>
    );
}

function DefaultLoginOptions({
    config,
    onSsoClick,
}: {
    config: AuthConfig;
    onSsoClick: () => void;
}) {
    return (
        <div className="space-y-4">
            {config.oidcEnabled && (
                <SsoButton
                    providerName={config.oidcProviderName}
                    onClick={onSsoClick}
                />
            )}
            {config.oidcEnabled && config.localLoginEnabled && (
                <div
                    className="flex items-center gap-3 text-xs text-white/40"
                    aria-hidden="true"
                >
                    <span className="h-px flex-1 bg-white/10" />
                    or
                    <span className="h-px flex-1 bg-white/10" />
                </div>
            )}
            {config.localLoginEnabled && <LocalLoginForm />}
        </div>
    );
}

function LoginScene({
    artists,
    currentIndex,
    children,
}: {
    artists: Artist[];
    currentIndex: number;
    children: ReactNode;
}) {
    const currentArtist = artists[currentIndex];
    return (
        <div className="min-h-screen w-full relative overflow-hidden">
            <LoginBackground
                currentArtist={currentArtist}
                currentIndex={currentIndex}
            />
            {currentArtist && <ArtistInfo artist={currentArtist} />}
            <div className="relative z-20 min-h-screen flex items-center justify-center p-4">
                <div className="w-full max-w-md">
                    <BrandLogo />
                    {children}
                    <p className="text-center text-white/40 text-sm mt-6">
                        © 2025 {BRAND_NAME}. {BRAND_MARKETING_TAGLINE}
                    </p>
                </div>
            </div>
        </div>
    );
}

function LoginBackground({
    currentArtist,
    currentIndex,
}: {
    currentArtist?: Artist;
    currentIndex: number;
}) {
    return (
        <div className="absolute inset-0 bg-[#000]">
            <div className="absolute inset-0 bg-gradient-to-br from-brand/5 via-transparent to-transparent" />
            <div className="opacity-[0.08]">
                <GalaxyBackground
                    primaryColor="#3b82f6"
                    secondaryColor="#3b82f6"
                />
            </div>
            {currentArtist?.heroUrl && (
                <>
                    <div
                        key={currentIndex}
                        className="absolute inset-0 transition-opacity duration-1000"
                    >
                        <Image
                            src={currentArtist.heroUrl}
                            alt={currentArtist.name}
                            fill
                            className="object-cover"
                            priority
                        />
                    </div>
                    <div className="absolute inset-0 backdrop-blur-[100px] bg-black/60" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent" />
                    <div className="absolute inset-0 bg-gradient-to-b from-black/80 via-transparent to-black/80" />
                </>
            )}
        </div>
    );
}

function ArtistInfo({ artist }: { artist: Artist }) {
    return (
        <div className="absolute bottom-8 left-8 z-10 text-white max-w-md animate-fade-in">
            <p className="text-sm font-medium text-white/60 mb-2">
                Featured Artist
            </p>
            <h2 className="text-3xl md:text-4xl font-bold mb-2 drop-shadow-2xl">
                {artist.name}
            </h2>
            {artist.albumCount !== undefined && (
                <p className="text-white/70 text-sm">
                    {artist.albumCount} album
                    {artist.albumCount !== 1 ? "s" : ""} in your library
                </p>
            )}
        </div>
    );
}

function BrandLogo() {
    return (
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
    );
}

/** Provides the Suspense boundary required by Next.js search parameters. */
export default function LoginPage() {
    return (
        <Suspense fallback={<LoadingPage />}>
            <LoginPageContent />
        </Suspense>
    );
}
