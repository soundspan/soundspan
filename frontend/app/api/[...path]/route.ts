import { proxyRequest } from "../../../lib/apiProxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteParams = { params: Promise<{ path: string[] }> };

// This route backs same-origin API mode. Direct mode bypasses it via absolute backend URLs.
export async function GET(request: Request, { params }: RouteParams) {
    const { path } = await params;
    return proxyRequest(request, `api/${path.join("/")}`);
}

export async function POST(request: Request, { params }: RouteParams) {
    const { path } = await params;
    return proxyRequest(request, `api/${path.join("/")}`);
}

export async function PUT(request: Request, { params }: RouteParams) {
    const { path } = await params;
    return proxyRequest(request, `api/${path.join("/")}`);
}

export async function PATCH(request: Request, { params }: RouteParams) {
    const { path } = await params;
    return proxyRequest(request, `api/${path.join("/")}`);
}

export async function DELETE(request: Request, { params }: RouteParams) {
    const { path } = await params;
    return proxyRequest(request, `api/${path.join("/")}`);
}
