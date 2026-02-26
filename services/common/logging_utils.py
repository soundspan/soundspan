"""Shared logging helpers for Python sidecar services."""

from __future__ import annotations

import asyncio
import functools
import logging
import os
import time
from typing import Any, Callable, TypeVar

R = TypeVar("R")

_TRUTHY_VALUES = {"1", "true", "yes", "on"}
_DEFAULT_FORMAT = "%(asctime)s [%(name)s] %(levelname)s: %(message)s"
_VALID_LEVEL_NAMES = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "warning": logging.WARNING,
    "error": logging.ERROR,
    "critical": logging.CRITICAL,
}


def _is_truthy(value: str | None) -> bool:
    if value is None:
        return False
    return value.strip().lower() in _TRUTHY_VALUES


def _resolve_level(
    *,
    default_level: str = "INFO",
    log_level_env: str = "LOG_LEVEL",
    debug_env: str = "DEBUG",
) -> int:
    configured = os.getenv(log_level_env, "").strip().lower()
    if configured:
        return _VALID_LEVEL_NAMES.get(configured, logging.INFO)

    if _is_truthy(os.getenv(debug_env)):
        return logging.DEBUG

    return _VALID_LEVEL_NAMES.get(default_level.strip().lower(), logging.INFO)


def configure_service_logger(
    service_name: str,
    *,
    default_level: str = "INFO",
    log_level_env: str = "LOG_LEVEL",
    debug_env: str = "DEBUG",
    fmt: str = _DEFAULT_FORMAT,
) -> logging.Logger:
    """Configure and return a named service logger."""
    level = _resolve_level(
        default_level=default_level,
        log_level_env=log_level_env,
        debug_env=debug_env,
    )
    logging.basicConfig(level=level, format=fmt)
    logger = logging.getLogger(service_name)
    logger.setLevel(level)
    return logger


def with_log_context(logger: logging.Logger, **context: Any) -> logging.LoggerAdapter:
    """Attach persistent context fields to all emitted records."""
    return logging.LoggerAdapter(logger, context)


def log_exceptions(
    logger: logging.Logger,
    message: str,
    *,
    level: int = logging.ERROR,
) -> Callable[[Callable[..., R]], Callable[..., R]]:
    """Decorator that logs unexpected exceptions and re-raises."""

    def decorator(func: Callable[..., R]) -> Callable[..., R]:
        if asyncio.iscoroutinefunction(func):

            @functools.wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> R:
                try:
                    return await func(*args, **kwargs)
                except Exception:
                    logger.log(level, message, exc_info=True)
                    raise

            return async_wrapper

        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> R:
            try:
                return func(*args, **kwargs)
            except Exception:
                logger.log(level, message, exc_info=True)
                raise

        return wrapper

    return decorator


def log_timing(
    logger: logging.Logger,
    operation: str,
    *,
    level: int = logging.INFO,
) -> Callable[[Callable[..., R]], Callable[..., R]]:
    """Decorator that logs operation duration for sync or async functions."""

    def decorator(func: Callable[..., R]) -> Callable[..., R]:
        if asyncio.iscoroutinefunction(func):

            @functools.wraps(func)
            async def async_wrapper(*args: Any, **kwargs: Any) -> R:
                start = time.perf_counter()
                try:
                    result = await func(*args, **kwargs)
                    logger.log(level, "%s completed in %.2fms", operation, (time.perf_counter() - start) * 1000.0)
                    return result
                except Exception:
                    logger.exception(
                        "%s failed after %.2fms",
                        operation,
                        (time.perf_counter() - start) * 1000.0,
                    )
                    raise

            return async_wrapper

        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> R:
            start = time.perf_counter()
            try:
                result = func(*args, **kwargs)
                logger.log(level, "%s completed in %.2fms", operation, (time.perf_counter() - start) * 1000.0)
                return result
            except Exception:
                logger.exception(
                    "%s failed after %.2fms",
                    operation,
                    (time.perf_counter() - start) * 1000.0,
                )
                raise

        return wrapper

    return decorator
