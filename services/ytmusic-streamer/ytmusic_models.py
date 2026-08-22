"""Request models for the YouTube Music sidecar HTTP boundary."""

from typing import Literal

from pydantic import BaseModel


class OAuthTokenPayload(BaseModel):
    """OAuth tokens stored by the backend."""

    oauth_json: str  # Full JSON string from ytmusicapi OAuth


class DeviceCodeRequest(BaseModel):
    """Request to initiate device code flow."""

    client_id: str
    client_secret: str


class DeviceCodePollRequest(BaseModel):
    """Request to poll for device code completion."""

    client_id: str
    client_secret: str
    device_code: str


class SearchRequest(BaseModel):
    """Payload for single-query YouTube Music search requests."""

    query: str
    filter: Literal["songs", "albums", "artists", "videos"] | None = None
    limit: int = 20


class BatchSearchQuery(BaseModel):
    """A single query within a batch search request."""

    query: str
    filter: Literal["songs", "albums", "artists", "videos"] | None = None
    limit: int = 5  # Lower default for batch — we only need top results


class BatchSearchRequest(BaseModel):
    """Batch of search queries to execute concurrently."""

    queries: list[BatchSearchQuery]


class YtDownloadRequest(BaseModel):
    # NOTE: no output_dir field — the write path is server configuration
    # (YT_DOWNLOAD_DIR). Accepting a caller-chosen path would let any client
    # write downloads to an arbitrary directory.
    video_id: str
    format: str = "mp3"
    quality: str = "HIGH"
    # Optional grouping label (e.g. the playlist/channel title) so the
    # downloads view can group a bulk run's jobs by where they came from.
    source: str | None = None
    # Bulk source type ("channel" | "playlist"). Only channels are collapsed to
    # a single artist on import; playlists keep each track's native metadata.
    source_kind: str | None = None


class YtAlbumDownloadRequest(BaseModel):
    """Server-rooted YouTube Music album download request."""

    browse_id: str
    format: Literal["mp3", "opus", "flac", "m4a"] = "mp3"
    quality: Literal["LOW", "MEDIUM", "HIGH", "LOSSLESS"] = "HIGH"
