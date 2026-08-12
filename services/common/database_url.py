"""PostgreSQL connection URL resolution shared by Python sidecars."""

from collections.abc import Mapping
from urllib.parse import quote


def resolve_database_url(environment: Mapping[str, str]) -> str:
    """Preserve an explicit URL or build one from complete PostgreSQL components."""
    explicit_database_url = environment.get("DATABASE_URL", "")
    if explicit_database_url:
        return explicit_database_url

    host = environment.get("POSTGRES_HOST")
    port = environment.get("POSTGRES_PORT")
    user = environment.get("POSTGRES_USER")
    password = environment.get("POSTGRES_PASSWORD")
    database = environment.get("POSTGRES_DB")
    if not host or not port or not user or not password or not database:
        return explicit_database_url

    encoded_user = quote(user, safe="")
    encoded_password = quote(password, safe="")
    return f"postgresql://{encoded_user}:{encoded_password}@{host}:{port}/{database}"
