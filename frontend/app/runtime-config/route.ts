import { NextResponse } from "next/server";
import { buildRuntimeConfigPayload } from "../../lib/runtime-config/normalization";

export const dynamic = "force-dynamic";

export function GET() {
    const payload = buildRuntimeConfigPayload(process.env);

    return new NextResponse(payload, {
        headers: {
            "content-type": "application/javascript; charset=utf-8",
            "cache-control": "no-store, max-age=0",
        },
    });
}
