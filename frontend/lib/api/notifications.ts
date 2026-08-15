import { type ApiClientConstructor, type ApiData } from "./core";

/** Add notifications-domain operations to an API client base class. */
export function WithNotifications<TBase extends ApiClientConstructor>(
    Base: TBase,
) {
    abstract class NotificationsApi extends Base {
        async getNotifications(): Promise<
            Array<{
                id: string;
                type: string;
                title: string;
                message: string | null;
                metadata: ApiData | null;
                read: boolean;
                cleared: boolean;
                createdAt: string;
            }>
        > {
            return this.get("/notifications");
        }

        async getUnreadNotificationCount(): Promise<{ count: number }> {
            return this.get("/notifications/unread-count");
        }

        async markNotificationAsRead(
            id: string,
        ): Promise<{ success: boolean }> {
            return this.post(`/notifications/${id}/read`);
        }

        async markAllNotificationsAsRead(): Promise<{ success: boolean }> {
            return this.post("/notifications/read-all");
        }

        async clearNotification(id: string): Promise<{ success: boolean }> {
            return this.post(`/notifications/${id}/clear`);
        }

        async clearAllNotifications(): Promise<{ success: boolean }> {
            return this.post("/notifications/clear-all");
        }

        async search(
            query: string,
            type:
                | "all"
                | "artists"
                | "albums"
                | "tracks"
                | "audiobooks"
                | "podcasts" = "all",
            limit: number = 20,
            signal?: AbortSignal,
            source: "all" | "local" | "peers" = "all",
        ) {
            return this.request<ApiData>(
                `/search?q=${encodeURIComponent(query)}&type=${type}&limit=${limit}&source=${source}`,
                { signal },
            );
        }
    }
    return NotificationsApi;
}
