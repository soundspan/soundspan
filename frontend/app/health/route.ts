import { proxyRequest } from "../../lib/apiProxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Executes GET.
 */
export async function GET(request: Request) {
    return proxyRequest(request, "health", "GET");
}