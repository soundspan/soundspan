"""Request models and credential values for the TIDAL HTTP boundary."""

from typing import Literal, NamedTuple

from pydantic import BaseModel


class AuthTokenRequest(BaseModel):
    """Payload for device-code token exchange polling."""

    device_code: str


class AuthTokensPayload(BaseModel):
    """Tokens and metadata provided by the Node.js backend."""

    access_token: str
    refresh_token: str
    user_id: str
    country_code: str


class SessionCheckPayload(BaseModel):
    """Payload for session verification."""

    access_token: str
    user_id: str
    country_code: str


class RefreshRequest(BaseModel):
    """Payload for refreshing a TIDAL access token."""

    refresh_token: str


class SearchRequest(BaseModel):
    """Payload for TIDAL catalog search queries."""

    query: str


class DownloadTrackRequest(BaseModel):
    """Payload for downloading a single TIDAL track."""

    track_id: int
    quality: Literal["LOW", "HIGH", "LOSSLESS", "HI_RES_LOSSLESS"] = "HIGH"
    output_template: str = "{album.artist}/{album.title}/{item.number:02d}. {item.title}"


class DownloadAlbumRequest(BaseModel):
    """Payload for downloading all tracks from a TIDAL album."""

    album_id: int
    quality: Literal["LOW", "HIGH", "LOSSLESS", "HI_RES_LOSSLESS"] = "HIGH"
    output_template: str = "{album.artist}/{album.title}/{item.number:02d}. {item.title}"


class UserAuthRestoreRequest(BaseModel):
    """Restore per-user OAuth credentials."""

    access_token: str
    refresh_token: str
    user_id: str
    country_code: str


class BatchSearchQuery(BaseModel):
    """Single query descriptor for batch TIDAL search requests."""

    query: str
    filter: str | None = None
    limit: int = 5


class AdminCredentials(NamedTuple):
    """Admin TIDAL credentials extracted from an incoming request."""

    access_token: str
    user_id: str
    country_code: str
