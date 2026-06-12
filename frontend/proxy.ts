import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Re-implements the default Next.js trailing-slash removal for non-API routes.
 *
 * We set `skipTrailingSlashRedirect: true` in next.config.ts to prevent a
 * redirect loop between express.static (301 /api/docs → /api/docs/) and
 * Next.js (308 /api/docs/ → /api/docs). This proxy restores the
 * original behavior for every route outside /api/.
 */
export function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl;

    // Allow trailing slashes on /api/ routes (swagger-ui needs them)
    if (pathname.startsWith("/api/")) {
        return NextResponse.next();
    }

    // For non-API routes, enforce no trailing slash (matches default Next.js behavior)
    if (pathname !== "/" && pathname.endsWith("/")) {
        const stripped = new URL(request.url);
        stripped.pathname = pathname.slice(0, -1);
        return NextResponse.redirect(stripped, 308);
    }

    return NextResponse.next();
}

export const config = {
    matcher: ["/((?!_next/static|_next/image|favicon.ico|assets/).*)"],
};
