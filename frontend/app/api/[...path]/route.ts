import { proxyRequest } from "../../../lib/apiProxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteParams = { params: Promise<{ path: string[] }> };

// This route backs same-origin API mode. Direct mode bypasses it via absolute backend URLs.

/**
 * Build the backend target path, preserving trailing slashes from the
 * original request URL. Next.js strips trailing slashes from catch-all
 * params, but swagger-ui needs /api/docs/ (with slash) to resolve its
 * relative asset URLs correctly.
 */
function buildTargetPath(request: Request, path: string[]): string {
    const base = `api/${path.join("/")}`;
    const url = new URL(request.url);
    if (url.pathname.endsWith("/") && !base.endsWith("/")) {
        return `${base}/`;
    }
    return base;
}

/**
 * Executes GET.
 */
export async function GET(request: Request, { params }: RouteParams) {
    const { path } = await params;
    return proxyRequest(request, buildTargetPath(request, path));
}

/**
 * Executes POST.
 */
export async function POST(request: Request, { params }: RouteParams) {
    const { path } = await params;
    return proxyRequest(request, buildTargetPath(request, path));
}

/**
 * Executes PUT.
 */
export async function PUT(request: Request, { params }: RouteParams) {
    const { path } = await params;
    return proxyRequest(request, buildTargetPath(request, path));
}

/**
 * Executes PATCH.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
    const { path } = await params;
    return proxyRequest(request, buildTargetPath(request, path));
}

/**
 * Executes DELETE.
 */
export async function DELETE(request: Request, { params }: RouteParams) {
    const { path } = await params;
    return proxyRequest(request, buildTargetPath(request, path));
}
