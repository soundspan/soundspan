"""Health route for the assembled TIDAL sidecar."""

from tidal_runtime import JsonObject, app


@app.get("/health")
async def health() -> JsonObject:
    """Report process health for container and orchestration probes."""
    return {"status": "ok", "service": "tidal-streamer"}
