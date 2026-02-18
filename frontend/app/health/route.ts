import { proxyRequest } from "../../lib/apiProxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
    return proxyRequest(request, "health", "GET");
}