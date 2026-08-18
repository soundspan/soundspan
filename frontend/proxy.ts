import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const CSP_REPORT_ONLY_HEADER = "Content-Security-Policy-Report-Only";
const CSP_ENFORCING_HEADER = "Content-Security-Policy";
const CSP_REPORTING_GROUP = "csp-endpoint";
const UNSAFE_REPORT_URI_CHARACTERS = /[\s;",\\]/u;

function getReportUri(value: string | undefined): string | null {
    const candidate = value?.trim();
    if (!candidate || UNSAFE_REPORT_URI_CHARACTERS.test(candidate)) {
        return null;
    }
    if (candidate.startsWith("/")) {
        return candidate.startsWith("//") ? null : candidate;
    }

    try {
        const parsed = new URL(candidate);
        return parsed.protocol === "https:" &&
            !parsed.username &&
            !parsed.password &&
            !parsed.hash
            ? candidate
            : null;
    } catch {
        return null;
    }
}

function buildContentSecurityPolicy(nonce: string): {
    policy: string;
    reportUri: string | null;
} {
    const developmentEval =
        process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
    const directives = [
        "default-src 'self'",
        `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentEval}`,
        // Deliberate compromise: Next.js and the styling pipeline inject
        // inline style attributes/tags that cannot carry nonces, so styles
        // allow 'unsafe-inline'. Script injection stays fully nonce-gated
        // above, which is where the XSS risk actually lives; revisit only
        // if the framework gains nonce-able style emission.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "connect-src 'self' ws: wss:",
        "worker-src 'self' blob:",
        "font-src 'self' data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ];
    const reportUri = getReportUri(process.env.CSP_REPORT_URI);
    if (reportUri) {
        directives.push(
            `report-uri ${reportUri}`,
            `report-to ${CSP_REPORTING_GROUP}`,
        );
    }
    return { policy: directives.join("; "), reportUri };
}

function addContentSecurityPolicy(request: NextRequest): {
    requestHeaders: Headers;
    headerName: string;
    policy: string;
    reportUri: string | null;
} {
    const nonce = crypto.randomUUID();
    const { policy, reportUri } = buildContentSecurityPolicy(nonce);
    const headerName =
        process.env.CSP_ENFORCE === "true"
            ? CSP_ENFORCING_HEADER
            : CSP_REPORT_ONLY_HEADER;
    const requestHeaders = new Headers(request.headers);

    // Next reads the request CSP and propagates its nonce to rendered scripts.
    requestHeaders.set(headerName, policy);
    requestHeaders.set("x-nonce", nonce);
    return { requestHeaders, headerName, policy, reportUri };
}

function setContentSecurityPolicyHeaders(
    response: NextResponse,
    csp: ReturnType<typeof addContentSecurityPolicy>,
): NextResponse {
    response.headers.set(csp.headerName, csp.policy);
    if (csp.reportUri) {
        response.headers.set(
            "Reporting-Endpoints",
            `${CSP_REPORTING_GROUP}="${csp.reportUri}"`,
        );
    }
    return response;
}

/**
 * Adds the per-request document CSP and restores non-API slash removal.
 *
 * We set `skipTrailingSlashRedirect: true` in next.config.ts to prevent a
 * redirect loop between express.static (301 /api/docs → /api/docs/) and
 * Next.js (308 /api/docs/ → /api/docs). This proxy restores the
 * original behavior for every route outside /api/.
 */
export function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl;
    const csp = addContentSecurityPolicy(request);

    // Allow trailing slashes on /api/ routes (swagger-ui needs them)
    if (pathname.startsWith("/api/")) {
        return setContentSecurityPolicyHeaders(
            NextResponse.next({ request: { headers: csp.requestHeaders } }),
            csp,
        );
    }

    // For non-API routes, enforce no trailing slash (matches default Next.js behavior)
    if (pathname !== "/" && pathname.endsWith("/")) {
        const stripped = new URL(request.url);
        stripped.pathname = pathname.slice(0, -1);
        return setContentSecurityPolicyHeaders(
            NextResponse.redirect(stripped, 308),
            csp,
        );
    }

    return setContentSecurityPolicyHeaders(
        NextResponse.next({ request: { headers: csp.requestHeaders } }),
        csp,
    );
}

export const config = {
    matcher: ["/((?!_next/static|_next/image|favicon.ico|assets/).*)"],
};
