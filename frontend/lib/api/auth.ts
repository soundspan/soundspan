import { type ApiClientConstructor } from "./core";

/** Public authentication capabilities returned by the backend. */
export interface AuthConfig {
    localLoginEnabled: boolean;
    oidcEnabled: boolean;
    oidcProviderName: string;
}

/** Safe metadata for an OIDC identity linked to the current user. */
export interface ExternalIdentity {
    id: string;
    provider: string;
    email: string | null;
    displayName: string | null;
    subjectHint: string;
    createdAt: string;
}

/** Safe metadata for an active OpenSubsonic app password. */
export interface AppPasswordMetadata {
    id: string;
    displayName: string;
    createdAt: string;
    lastUsedAt: string | null;
}

/** A newly created app password whose secret is returned only once. */
export interface CreatedAppPassword extends AppPasswordMetadata {
    secret: string;
}

/** User fields returned after any successful login flow. */
export interface AuthenticatedUser {
    id: string;
    username: string;
    displayName?: string | null;
    role: string;
    requires2FA?: boolean;
    onboardingComplete?: boolean;
}

/** Credentials used to confirm an email-matched OIDC account link. */
export interface ConfirmOidcLinkPayload {
    linkToken: string;
    password: string;
    twoFactorToken?: string;
}

/** Invite details used to provision an OIDC-authenticated account. */
export interface RedeemOidcInvitePayload {
    inviteToken: string;
    inviteCode: string;
}

/** Challenge returned when account linking requires a local second factor. */
export interface RequiresTwoFactorResponse {
    requires2FA: true;
    message: string;
}

interface LoginResponse {
    token: string;
    refreshToken: string;
    user: AuthenticatedUser;
}

/** Add auth-domain operations to an API client base class. */
export function WithAuth<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class AuthApi extends Base {
        private storeAuthTokens(token: string, refreshToken?: string): void {
            this.setToken(token, refreshToken);
        }

        private completeLogin(response: LoginResponse): AuthenticatedUser {
            this.storeAuthTokens(response.token, response.refreshToken);
            return response.user;
        }

        async getOnboardingStatus(): Promise<{
            needsOnboarding: boolean;
            hasAccount: boolean;
        }> {
            return this.request<{
                needsOnboarding: boolean;
                hasAccount: boolean;
            }>("/onboarding/status", { silent404: true });
        }

        async login(
            username: string,
            password: string,
            token?: string,
        ): Promise<AuthenticatedUser> {
            const data = await this.request<{
                token?: string;
                refreshToken?: string;
                user?: {
                    id: string;
                    username: string;
                    displayName?: string | null;
                    role: string;
                    requires2FA?: boolean;
                    onboardingComplete?: boolean;
                };
                id?: string;
                username?: string;
                displayName?: string | null;
                role?: string;
                requires2FA?: boolean;
                onboardingComplete?: boolean;
            }>("/auth/login", {
                method: "POST",
                body: JSON.stringify({ username, password, token }),
            });

            // If login returned JWT tokens, store them
            if (data.token) {
                this.storeAuthTokens(data.token, data.refreshToken);
            }

            // Return user data in consistent format
            if (data.user) {
                return data.user;
            }
            return {
                id: data.id || "",
                username: data.username || "",
                displayName: data.displayName,
                role: data.role || "",
                requires2FA: data.requires2FA,
                onboardingComplete: data.onboardingComplete,
            };
        }

        /** Loads public local-login and OIDC capability flags. */
        async getAuthConfig(): Promise<AuthConfig> {
            return this.request<AuthConfig>("/auth/config");
        }

        /** Starts an authenticated OIDC link attempt and returns its navigation URL. */
        async startOidcLink(): Promise<{ redirectUrl: string }> {
            return this.request<{ redirectUrl: string }>(
                "/auth/oidc/link/start",
                {
                    method: "POST",
                    body: JSON.stringify({ responseMode: "json" }),
                },
            );
        }

        /** Lists OIDC identities linked to the current account. */
        async getExternalIdentities(): Promise<{
            identities: ExternalIdentity[];
        }> {
            return this.request<{ identities: ExternalIdentity[] }>(
                "/auth/identities",
            );
        }

        /** Unlinks one identity owned by the current account. */
        async unlinkExternalIdentity(id: string): Promise<{ message: string }> {
            return this.request<{ message: string }>(
                `/auth/identities/${encodeURIComponent(id)}`,
                { method: "DELETE" },
            );
        }

        /** Lists active app-password metadata without secret values. */
        async listAppPasswords(): Promise<{
            appPasswords: AppPasswordMetadata[];
        }> {
            return this.request<{ appPasswords: AppPasswordMetadata[] }>(
                "/auth/app-passwords",
            );
        }

        /** Creates an app password and returns its one-time plaintext secret. */
        async createAppPassword(
            displayName: string,
        ): Promise<{ appPassword: CreatedAppPassword }> {
            return this.request<{ appPassword: CreatedAppPassword }>(
                "/auth/app-passwords",
                {
                    method: "POST",
                    body: JSON.stringify({ displayName }),
                },
            );
        }

        /** Revokes one app password owned by the current account. */
        async revokeAppPassword(id: string): Promise<{ message: string }> {
            return this.request<{ message: string }>(
                `/auth/app-passwords/${encodeURIComponent(id)}`,
                { method: "DELETE" },
            );
        }

        /** Exchanges a one-time OIDC callback code and stores login tokens. */
        async exchangeOidcCode(code: string): Promise<AuthenticatedUser> {
            const response = await this.request<LoginResponse>(
                "/auth/oidc/exchange",
                {
                    method: "POST",
                    body: JSON.stringify({ code }),
                },
            );
            return this.completeLogin(response);
        }

        /** Confirms an OIDC link and stores tokens unless 2FA is required. */
        async confirmOidcLink(
            payload: ConfirmOidcLinkPayload,
        ): Promise<AuthenticatedUser | RequiresTwoFactorResponse> {
            const response = await this.request<
                LoginResponse | RequiresTwoFactorResponse
            >("/auth/oidc/confirm-link", {
                method: "POST",
                body: JSON.stringify(payload),
            });
            if ("requires2FA" in response) return response;
            return this.completeLogin(response);
        }

        /** Redeems an invite for OIDC provisioning and stores login tokens. */
        async redeemOidcInvite(
            payload: RedeemOidcInvitePayload,
        ): Promise<AuthenticatedUser> {
            const response = await this.request<LoginResponse>(
                "/auth/oidc/redeem-invite",
                {
                    method: "POST",
                    body: JSON.stringify(payload),
                },
            );
            return this.completeLogin(response);
        }

        async register(fields: {
            inviteCode: string;
            username: string;
            displayName: string;
            password: string;
            confirmPassword: string;
            email: string;
        }) {
            const data = await this.request<{
                token: string;
                refreshToken: string;
                user: {
                    id: string;
                    username: string;
                    displayName: string | null;
                    role: string;
                };
            }>("/auth/register", {
                method: "POST",
                body: JSON.stringify(fields),
            });
            // Store tokens on success
            if (data.token) {
                this.storeAuthTokens(data.token, data.refreshToken);
            }
            return data;
        }

        async createInviteCode(ttl: string, maxUses?: number) {
            return this.request<{
                id: string;
                code: string;
                expiresAt: string | null;
                maxUses: number;
                createdAt: string;
            }>("/auth/invite-codes", {
                method: "POST",
                body: JSON.stringify({ ttl, maxUses: maxUses ?? 1 }),
            });
        }

        async getInviteCodes() {
            return this.request<
                Array<{
                    id: string;
                    code: string;
                    status: "active" | "expired" | "exhausted" | "revoked";
                    maxUses: number;
                    useCount: number;
                    expiresAt: string | null;
                    createdAt: string;
                    createdBy: string;
                }>
            >("/auth/invite-codes");
        }

        async revokeInviteCode(id: string) {
            return this.request<{ message: string }>(
                `/auth/invite-codes/${id}`,
                {
                    method: "DELETE",
                },
            );
        }

        async logout() {
            await this.request<void>("/auth/logout", {
                method: "POST",
            });
            // Clear the stored JWT token
            this.clearToken();
        }

        async getCurrentUser() {
            return this.request<{
                id: string;
                username: string;
                displayName?: string | null;
                role: string;
                onboardingComplete?: boolean;
                enrichmentSettings?: { enabled: boolean; lastRun?: string };
                createdAt: string;
            }>("/auth/me");
        }

        async getSubsonicPasswordStatus(): Promise<{ hasPassword: boolean }> {
            return this.request<{ hasPassword: boolean }>(
                "/auth/subsonic-password",
            );
        }

        async setSubsonicPassword(
            password: string,
        ): Promise<{ success: boolean }> {
            return this.request<{ success: boolean }>(
                "/auth/subsonic-password",
                {
                    method: "POST",
                    body: JSON.stringify({ password }),
                },
            );
        }

        async clearSubsonicPassword(): Promise<{ success: boolean }> {
            return this.request<{ success: boolean }>(
                "/auth/subsonic-password",
                {
                    method: "DELETE",
                },
            );
        }

        async createApiKey(deviceName: string): Promise<{
            apiKey: string;
            name: string;
            createdAt: string;
            expiresAt: string;
            message: string;
        }> {
            return this.post("/api-keys", { deviceName });
        }

        async listApiKeys(): Promise<{
            apiKeys: Array<{
                id: string;
                name: string;
                createdAt: string;
                expiresAt: string;
                lastUsed: string | null;
            }>;
        }> {
            return this.get("/api-keys");
        }

        async revokeApiKey(id: string): Promise<{ message: string }> {
            return this.delete(`/api-keys/${id}`);
        }
    }
    return AuthApi;
}
