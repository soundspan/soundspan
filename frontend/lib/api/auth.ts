import { type ApiClientConstructor } from "./core";

/** Add auth-domain operations to an API client base class. */
export function WithAuth<TBase extends ApiClientConstructor>(Base: TBase) {
    abstract class AuthApi extends Base {
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
        ): Promise<{
            id: string;
            username: string;
            displayName?: string | null;
            role: string;
            requires2FA?: boolean;
            onboardingComplete?: boolean;
        }> {
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
                this.setToken(data.token, data.refreshToken);
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
                this.setToken(data.token, data.refreshToken);
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
