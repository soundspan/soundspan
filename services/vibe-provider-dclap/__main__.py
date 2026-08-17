"""Run the standalone DCLAP provider under Uvicorn on the main thread."""

from __future__ import annotations

import uvicorn
from http_server import create_app
from model_provider import DclapProvider
from settings import HTTP_PORT


def main() -> None:
    """Run Uvicorn directly so it owns main-thread signal handling."""
    config = uvicorn.Config(
        create_app(DclapProvider()),
        host="0.0.0.0",  # noqa: S104 -- internal container service accepts network traffic
        port=HTTP_PORT,
    )
    server = uvicorn.Server(config)
    server.run()


if __name__ == "__main__":
    main()
