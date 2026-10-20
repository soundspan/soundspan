"use client";

import { useAuth } from "@/lib/auth-context";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { RequestsView } from "@/features/requests/components/RequestsView";

/** Role-aware request queue: admins review everything, users see their own. */
export default function RequestsPage() {
    const { user, isAuthenticated, isLoading: authLoading } = useAuth();

    if (authLoading) {
        return (
            <div className="flex min-h-screen items-center justify-center">
                <GradientSpinner size="md" />
            </div>
        );
    }
    if (!isAuthenticated) return null;

    return (
        <RequestsView isAdmin={user?.role === "admin"} viewerId={user?.id} />
    );
}
