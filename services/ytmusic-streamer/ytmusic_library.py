"""Authenticated metadata and user-library HTTP routes."""

import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Literal, cast

from common.sidecar_runtime_utils import env_int
from fastapi import HTTPException, Query
from ytmusic_client import _get_public_ytmusic, _run_ytmusic_with_auth_retry
from ytmusic_runtime import JsonObject, _sanitized_http_error, app, log
from ytmusic_stream import BROWSE_TIMEOUT, _browse_public_bounded, _validate_video_id
from ytmusicapi.exceptions import YTMusicServerError

_AUTO_PLAYLIST_PREFIXES = ("RDTMAK", "RDEM", "RDAMPL", "RDAuto", "RDCLAK", "RDAO")
_SPECIAL_PLAYLIST_IDS = {"LM", "SE", "RDPN"}
LIBRARY_ERROR_CACHE_SECONDS = max(0, env_int("YTMUSIC_LIBRARY_ERROR_CACHE_SECONDS", "600"))
LIBRARY_ERROR_CACHE_MAX = 1000
LIBRARY_PLAYLIST_PROVIDER_CONCURRENCY = 8
_LIBRARY_PLAYLIST_ERROR_DETAIL = "YouTube Music library playlists are temporarily unavailable"
_LIBRARY_PLAYLIST_TIMEOUT_DETAIL = "YouTube Music library playlists request timed out"
_LIBRARY_PLAYLIST_PROVIDER_TIMEOUT_GRACE_SECONDS = 1.0
_LIBRARY_PLAYLIST_PROVIDER_DRAIN_SECONDS = 20.0
_LibraryPlaylistKey = tuple[str, int, bool]
_LibraryPlaylistTask = asyncio.Task[JsonObject]
_LibraryPlaylistFlight = tuple[_LibraryPlaylistTask, int]
_LibraryPlaylistProviderJob = asyncio.Future[list[JsonObject]]
_LibraryCredentialMutationToken = int


class _LibraryPlaylistProviderDeadlineError(TimeoutError):
    """Identify expiry of the registry-owned provider deadline."""


_library_playlist_error_cache: dict[_LibraryPlaylistKey, float] = {}
_library_playlist_error_cache_lock = threading.Lock()
_library_playlist_error_now = time.monotonic
_library_playlist_inflight: dict[_LibraryPlaylistKey, _LibraryPlaylistFlight] = {}
_library_playlist_tasks: dict[_LibraryPlaylistTask, tuple[_LibraryPlaylistKey, int]] = {}
_library_playlist_generations: dict[str, int] = {}
_library_playlist_credential_mutations: dict[str, set[_LibraryCredentialMutationToken]] = {}
_library_playlist_inflight_condition = asyncio.Condition()
_library_playlist_provider_executor = ThreadPoolExecutor(
    max_workers=LIBRARY_PLAYLIST_PROVIDER_CONCURRENCY,
    thread_name_prefix="ytmusic-library-playlists",
)
_library_playlist_provider_jobs: set[_LibraryPlaylistProviderJob] = set()
_library_playlist_provider_admitting = True


def _consume_library_playlist_provider_job(job: _LibraryPlaylistProviderJob) -> None:
    """Retire a provider job only after its underlying executor thread settles."""
    _library_playlist_provider_jobs.discard(job)
    if not job.cancelled():
        _ = job.exception()


def _call_library_playlist_provider(user_id: str, limit: int) -> list[JsonObject]:
    """Run one blocking library-playlist provider call."""
    return cast(
        list[JsonObject],
        _run_ytmusic_with_auth_retry(
            user_id,
            f"get_library_playlists(limit={limit})",
            lambda yt: yt.get_library_playlists(limit),
        ),
    )


def _submit_library_playlist_provider_job(user_id: str, limit: int) -> _LibraryPlaylistProviderJob:
    """Admit one provider call without queueing beyond the dedicated pool."""
    if (
        not _library_playlist_provider_admitting
        or len(_library_playlist_provider_jobs) >= LIBRARY_PLAYLIST_PROVIDER_CONCURRENCY
    ):
        raise HTTPException(status_code=503, detail=_LIBRARY_PLAYLIST_ERROR_DETAIL)

    loop = asyncio.get_running_loop()
    job = cast(
        _LibraryPlaylistProviderJob,
        loop.run_in_executor(
            _library_playlist_provider_executor,
            _call_library_playlist_provider,
            user_id,
            limit,
        ),
    )
    _library_playlist_provider_jobs.add(job)
    job.add_done_callback(_consume_library_playlist_provider_job)
    return job


def _drain_library_playlist_provider_executor(
    drained: asyncio.Event,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Drain the provider executor and report completion to the event loop."""
    try:
        _library_playlist_provider_executor.shutdown(wait=True, cancel_futures=True)
    except Exception:
        log.exception("YouTube Music library-playlist provider executor drain failed")
    finally:
        try:
            loop.call_soon_threadsafe(drained.set)
        except RuntimeError:
            return


async def shutdown_library_playlist_provider() -> None:
    """Stop provider admission and bound the dedicated executor drain."""
    global _library_playlist_provider_admitting

    _library_playlist_provider_admitting = False
    loop = asyncio.get_running_loop()
    drained = asyncio.Event()
    drain_thread = threading.Thread(
        target=_drain_library_playlist_provider_executor,
        args=(drained, loop),
        name="ytmusic-library-playlists-shutdown",
        daemon=True,
    )
    drain_thread.start()
    try:
        async with asyncio.timeout(_LIBRARY_PLAYLIST_PROVIDER_DRAIN_SECONDS):
            await drained.wait()
    except TimeoutError:
        # Admission is closed and cache writes are generation-fenced. The daemon
        # waiter may be abandoned so the orchestrator can terminate stuck provider
        # threads with the process after the remaining shutdown grace expires.
        log.warning(
            "YouTube Music library-playlist provider drain exceeded %.1f seconds",
            _LIBRARY_PLAYLIST_PROVIDER_DRAIN_SECONDS,
        )


async def _run_library_playlist_provider(user_id: str, limit: int) -> list[JsonObject]:
    """Await dedicated provider work while retaining timed-out executor jobs."""
    job = _submit_library_playlist_provider_job(user_id, limit)
    deadline = asyncio.timeout(BROWSE_TIMEOUT + _LIBRARY_PLAYLIST_PROVIDER_TIMEOUT_GRACE_SECONDS)
    try:
        async with deadline:
            return await asyncio.shield(job)
    except TimeoutError as error:
        if deadline.expired():
            raise _LibraryPlaylistProviderDeadlineError from error
        raise


async def _reserve_library_playlist_slot(
    key: _LibraryPlaylistKey, deadline: float
) -> _LibraryPlaylistTask:
    """Join or create one bounded task for an exact playlist response."""
    try:
        async with asyncio.timeout_at(deadline):
            async with _library_playlist_inflight_condition:
                await _library_playlist_inflight_condition.wait_for(
                    lambda: (
                        key in _library_playlist_inflight
                        or len(_library_playlist_tasks) < LIBRARY_ERROR_CACHE_MAX
                    )
                )
                flight = _library_playlist_inflight.get(key)
                if flight is not None:
                    return flight[0]
                generation = _library_playlist_generations.get(key[0], 0)
                task = asyncio.create_task(_run_library_playlist_flight(key, generation))
                _library_playlist_inflight[key] = (task, generation)
                _library_playlist_tasks[task] = (key, generation)
                task.add_done_callback(_consume_library_playlist_task)
                return task
    except TimeoutError as error:
        raise HTTPException(
            status_code=503,
            detail=_LIBRARY_PLAYLIST_ERROR_DETAIL,
        ) from error


def _consume_library_playlist_task(task: _LibraryPlaylistTask) -> None:
    """Observe a settled task when every request waiter has disconnected."""
    if not task.cancelled():
        _ = task.exception()


def _forward_library_playlist_outcome(
    task: _LibraryPlaylistTask, waiter: asyncio.Future[JsonObject]
) -> None:
    """Copy a settled flight outcome without transferring task ownership."""
    if waiter.done():
        return
    if task.cancelled():
        waiter.cancel()
        return
    error = task.exception()
    if error is not None:
        waiter.set_exception(error)
        return
    waiter.set_result(task.result())


async def _retire_library_playlist_flight(
    key: _LibraryPlaylistKey, task: _LibraryPlaylistTask, generation: int
) -> None:
    """Retire one settled task without removing a credential-era replacement."""
    async with _library_playlist_inflight_condition:
        if _library_playlist_inflight.get(key) == (task, generation):
            _library_playlist_inflight.pop(key, None)
        _library_playlist_tasks.pop(task, None)
        _discard_library_playlist_generation_if_inactive(key[0])
        _library_playlist_inflight_condition.notify_all()


def _is_current_library_playlist_flight(
    key: _LibraryPlaylistKey, task: _LibraryPlaylistTask, generation: int
) -> bool:
    """Return whether a task may update cache state for its credential era."""
    return (
        key[0] not in _library_playlist_credential_mutations
        and _library_playlist_generations.get(key[0], 0) == generation
        and _library_playlist_inflight.get(key) == (task, generation)
    )


async def _run_library_playlist_flight(key: _LibraryPlaylistKey, generation: int) -> JsonObject:
    """Own provider work until it settles, even if every request stops waiting."""
    task = cast(_LibraryPlaylistTask, asyncio.current_task())
    try:
        return await _load_library_playlists(key, task, generation)
    finally:
        await _retire_library_playlist_flight(key, task, generation)


async def _await_library_playlist_flight(task: _LibraryPlaylistTask, deadline: float) -> JsonObject:
    """Bound one request wait without cancelling the registry-owned provider task."""
    waiter: asyncio.Future[JsonObject] = asyncio.get_running_loop().create_future()

    def forward_outcome(completed_task: _LibraryPlaylistTask) -> None:
        _forward_library_playlist_outcome(completed_task, waiter)

    task.add_done_callback(forward_outcome)
    try:
        # The flight registry owns the must-complete provider task. Only this
        # request's proxy future is cancelled on timeout or client disconnect.
        async with asyncio.timeout_at(deadline):
            return await waiter
    except TimeoutError as error:
        raise HTTPException(status_code=504, detail=_LIBRARY_PLAYLIST_TIMEOUT_DETAIL) from error
    finally:
        task.remove_done_callback(forward_outcome)


async def _load_library_playlists_singleflight(
    user_id: str, limit: int, mixes_only: bool
) -> JsonObject:
    """Share one exact response outcome across concurrent request waiters."""
    key = (user_id, limit, mixes_only)
    deadline = asyncio.get_running_loop().time() + BROWSE_TIMEOUT
    task = await _reserve_library_playlist_slot(key, deadline)
    return await _await_library_playlist_flight(task, deadline)


def _is_library_playlist_error_cached(key: _LibraryPlaylistKey) -> bool:
    """Return whether an exact request shape's playlist 400 is within its TTL."""
    now = _library_playlist_error_now()
    with _library_playlist_error_cache_lock:
        expires_at = _library_playlist_error_cache.get(key)
        if expires_at is None:
            return False
        if expires_at <= now:
            _library_playlist_error_cache.pop(key, None)
            return False
        return True


def _remember_library_playlist_error(key: _LibraryPlaylistKey) -> None:
    """Cache one stable upstream playlist failure and retain insertion order."""
    if LIBRARY_ERROR_CACHE_SECONDS == 0:
        return
    expires_at = _library_playlist_error_now() + LIBRARY_ERROR_CACHE_SECONDS
    with _library_playlist_error_cache_lock:
        _library_playlist_error_cache.pop(key, None)
        _library_playlist_error_cache[key] = expires_at
        if len(_library_playlist_error_cache) > LIBRARY_ERROR_CACHE_MAX:
            _library_playlist_error_cache.pop(next(iter(_library_playlist_error_cache)))


def _clear_library_playlist_error(key: _LibraryPlaylistKey) -> None:
    """Remove one request shape's negative entry after provider success."""
    with _library_playlist_error_cache_lock:
        _library_playlist_error_cache.pop(key, None)


def _clear_library_playlist_errors_for_user(user_id: str) -> None:
    """Remove every negative entry tied to one user's credentials."""
    with _library_playlist_error_cache_lock:
        stale_keys = [key for key in _library_playlist_error_cache if key[0] == user_id]
        for key in stale_keys:
            _library_playlist_error_cache.pop(key, None)


def _invalidate_library_playlist_generation(user_id: str) -> None:
    """Advance one user's generation and detach its joinable flights."""
    _library_playlist_generations[user_id] = _library_playlist_generations.get(user_id, 0) + 1
    stale_keys = [key for key in _library_playlist_inflight if key[0] == user_id]
    for key in stale_keys:
        _library_playlist_inflight.pop(key, None)
    _clear_library_playlist_errors_for_user(user_id)


def _discard_library_playlist_generation_if_inactive(user_id: str) -> None:
    """Release bounded generation state after all user work and mutations settle."""
    if user_id in _library_playlist_credential_mutations:
        return
    if any(key[0] == user_id for key, _generation in _library_playlist_tasks.values()):
        return
    _library_playlist_generations.pop(user_id, None)


async def clear_library_error_cache(user_id: str) -> None:
    """Invalidate cached and joinable playlist work after credential mutation."""
    async with _library_playlist_inflight_condition:
        _invalidate_library_playlist_generation(user_id)
        _discard_library_playlist_generation_if_inactive(user_id)
        _library_playlist_inflight_condition.notify_all()


async def begin_library_credential_mutation(user_id: str) -> _LibraryCredentialMutationToken:
    """Detach old work before a credential mutation starts external I/O."""
    async with _library_playlist_inflight_condition:
        _invalidate_library_playlist_generation(user_id)
        token = _library_playlist_generations[user_id]
        active_tokens = _library_playlist_credential_mutations.setdefault(user_id, set())
        active_tokens.add(token)
        _library_playlist_inflight_condition.notify_all()
        return token


def settle_abandoned_library_credential_mutation(
    user_id: str, token: _LibraryCredentialMutationToken
) -> None:
    """Retire a settled indeterminate worker without reopening its cache fence."""
    active_tokens = _library_playlist_credential_mutations.get(user_id)
    if active_tokens is not None:
        active_tokens.discard(token)


async def finish_library_credential_mutation(
    user_id: str, token: _LibraryCredentialMutationToken
) -> None:
    """Sweep work admitted during a credential mutation and close its generation."""
    async with _library_playlist_inflight_condition:
        _invalidate_library_playlist_generation(user_id)
        active_tokens = _library_playlist_credential_mutations.get(user_id)
        if active_tokens is not None:
            active_tokens.discard(token)
            if not active_tokens:
                _library_playlist_credential_mutations.pop(user_id, None)
        _discard_library_playlist_generation_if_inactive(user_id)
        _library_playlist_inflight_condition.notify_all()


def _is_upstream_library_bad_request(error: Exception) -> bool:
    """Identify ytmusicapi's stable server-side HTTP 400 error class."""
    if not isinstance(error, YTMusicServerError):
        return False
    response = getattr(error, "response", None)
    if getattr(response, "status_code", None) == 400:
        return True
    return "server returned http 400" in str(error).lower()


def _format_album_response(browse_id: str, album: JsonObject) -> JsonObject:
    """Build a normalized album response dict from a ytmusicapi get_album() result."""
    tracks = []
    for t in album.get("tracks", []):
        artists = t.get("artists", [])
        tracks.append(
            {
                "videoId": t.get("videoId"),
                "title": t.get("title"),
                "artist": artists[0].get("name") if artists else "Unknown",
                "artists": [a.get("name") for a in artists],
                "trackNumber": t.get("trackNumber"),
                "duration": t.get("duration"),
                "duration_seconds": t.get("duration_seconds"),
                "isExplicit": t.get("isExplicit", False),
                "likeStatus": t.get("likeStatus"),
            }
        )

    thumbnails = album.get("thumbnails", [])
    return {
        "browseId": browse_id,
        "title": album.get("title"),
        "artist": album.get("artists", [{}])[0].get("name") if album.get("artists") else "Unknown",
        "artists": [a.get("name") for a in album.get("artists", [])],
        "year": album.get("year"),
        "trackCount": album.get("trackCount"),
        "duration": album.get("duration"),
        "type": album.get("type", "Album"),
        "thumbnails": thumbnails,
        "coverUrl": thumbnails[-1].get("url") if thumbnails else None,
        "tracks": tracks,
        "description": album.get("description"),
    }


async def get_public_album_metadata(browse_id: str) -> JsonObject:
    """Fetch and normalize an album through the public browse client."""
    yt = _get_public_ytmusic("native")
    album = await _browse_public_bounded(yt.get_album, browse_id)
    return _format_album_response(browse_id, album)


@app.get("/album/{browse_id}")
async def get_album(browse_id: str, user_id: str = Query(...)) -> JsonObject:
    """Get album details and track listing from YouTube Music.

    When user_id is "__public__", uses an unauthenticated YTMusic instance.
    """
    try:
        if user_id == "__public__":
            return await get_public_album_metadata(browse_id)
        album = await asyncio.to_thread(
            _run_ytmusic_with_auth_retry,
            user_id,
            operation=f"get_album({browse_id})",
            func=lambda yt: yt.get_album(browse_id),
        )
        return _format_album_response(browse_id, album)
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(f"Get album {browse_id}", e, 500, "Failed to load album") from e


@app.get("/artist/{channel_id}")
async def get_artist(channel_id: str, user_id: str = Query(...)) -> JsonObject:
    """Get artist details from YouTube Music.

    When user_id is "__public__", uses an unauthenticated YTMusic instance.
    """
    try:
        if user_id == "__public__":
            yt = _get_public_ytmusic("native")
            artist = await _browse_public_bounded(yt.get_artist, channel_id)
        else:
            artist = await asyncio.to_thread(
                _run_ytmusic_with_auth_retry,
                user_id,
                operation=f"get_artist({channel_id})",
                func=lambda yt: yt.get_artist(channel_id),
            )

        songs = []
        for s in (artist.get("songs", {}).get("results", []))[:10]:
            artists = s.get("artists", [])
            songs.append(
                {
                    "videoId": s.get("videoId"),
                    "title": s.get("title"),
                    "artist": artists[0].get("name") if artists else "Unknown",
                    "album": s.get("album", {}).get("name") if s.get("album") else None,
                    "duration": s.get("duration"),
                }
            )

        albums = []
        for a in (artist.get("albums", {}).get("results", []))[:20]:
            albums.append(
                {
                    "browseId": a.get("browseId"),
                    "title": a.get("title"),
                    "year": a.get("year"),
                    "type": a.get("type", "Album"),
                    "thumbnails": a.get("thumbnails", []),
                }
            )

        thumbnails = artist.get("thumbnails", [])
        return {
            "channelId": channel_id,
            "name": artist.get("name"),
            "description": artist.get("description"),
            "thumbnails": thumbnails,
            "subscribers": artist.get("subscribers"),
            "songs": songs,
            "albums": albums,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"Get artist {channel_id}", e, 500, "Failed to load artist"
        ) from e


@app.get("/song/{video_id}")
async def get_song(video_id: str, user_id: str = Query(...)) -> JsonObject:
    """Get song metadata from YouTube Music.

    When user_id is "__public__", uses an unauthenticated YTMusic instance.
    """
    video_id = _validate_video_id(video_id)
    try:
        if user_id == "__public__":
            yt = _get_public_ytmusic("native")
            song = await _browse_public_bounded(yt.get_song, video_id)
        else:
            song = await asyncio.to_thread(
                _run_ytmusic_with_auth_retry,
                user_id,
                operation=f"get_song({video_id})",
                func=lambda yt: yt.get_song(video_id),
            )
        video_details = song.get("videoDetails", {})

        return {
            "videoId": video_details.get("videoId"),
            "title": video_details.get("title"),
            "artist": video_details.get("author"),
            "duration": int(video_details.get("lengthSeconds", 0)),
            "thumbnails": video_details.get("thumbnail", {}).get("thumbnails", []),
            "isOwner": video_details.get("isOwnerViewing", False),
            "viewCount": video_details.get("viewCount"),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(f"Get song {video_id}", e, 500, "Failed to load song") from e


@app.get("/library/songs")
async def library_songs(
    user_id: str = Query(...), limit: int = 100, order: str = "recently_added"
) -> JsonObject:
    """Get user's liked/library songs from YouTube Music."""
    try:
        songs = await asyncio.to_thread(
            _run_ytmusic_with_auth_retry,
            user_id,
            operation=f"get_library_songs(limit={limit}, order={order})",
            func=lambda yt: yt.get_library_songs(
                limit=limit,
                order=cast(Literal["a_to_z", "z_to_a", "recently_added"], order),
            ),
        )
        items = []
        for s in songs:
            artists = s.get("artists", [])
            album = s.get("album", {}) or {}
            items.append(
                {
                    "videoId": s.get("videoId"),
                    "title": s.get("title"),
                    "artist": artists[0].get("name") if artists else "Unknown",
                    "artists": [a.get("name") for a in artists],
                    "album": album.get("name") if album else None,
                    "duration": s.get("duration"),
                    "duration_seconds": s.get("duration_seconds"),
                    "thumbnails": s.get("thumbnails", []),
                }
            )
        return {"songs": items, "total": len(items)}
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"Get library songs for user {user_id}",
            e,
            500,
            "Failed to load library songs",
        ) from e


@app.get("/library/albums")
async def library_albums(
    user_id: str = Query(...), limit: int = 100, order: str = "recently_added"
) -> JsonObject:
    """Get user's saved albums from YouTube Music."""
    try:
        albums = await asyncio.to_thread(
            _run_ytmusic_with_auth_retry,
            user_id,
            operation=f"get_library_albums(limit={limit}, order={order})",
            func=lambda yt: yt.get_library_albums(
                limit=limit,
                order=cast(Literal["a_to_z", "z_to_a", "recently_added"], order),
            ),
        )
        items = []
        for a in albums:
            artists = a.get("artists", [])
            items.append(
                {
                    "browseId": a.get("browseId"),
                    "title": a.get("title"),
                    "artist": artists[0].get("name") if artists else "Unknown",
                    "artists": [a_name.get("name") for a_name in artists],
                    "year": a.get("year"),
                    "thumbnails": a.get("thumbnails", []),
                    "type": a.get("type", "Album"),
                }
            )
        return {"albums": items, "total": len(items)}
    except HTTPException:
        raise
    except Exception as e:
        raise _sanitized_http_error(
            f"Get library albums for user {user_id}",
            e,
            500,
            "Failed to load library albums",
        ) from e


@app.get("/library/playlists")
async def library_playlists(
    user_id: str = Query(...),
    limit: int = Query(25, ge=1, le=100),
    mixes_only: bool = False,
) -> JsonObject:
    """Get user's library playlists from YouTube Music.

    When mixes_only=true, filters to auto-generated/personalized mixes
    (e.g. "My Supermix", "Discover Mix", "Fresh finds, old favorites"),
    excluding user-created playlists and special IDs like Liked Music.
    """
    return await _load_library_playlists_singleflight(user_id, limit, mixes_only)


async def _load_library_playlists(
    key: _LibraryPlaylistKey, task: _LibraryPlaylistTask, generation: int
) -> JsonObject:
    """Load playlists after single-flight admission and map provider failures."""
    user_id, limit, mixes_only = key
    if _is_library_playlist_error_cached(key):
        raise HTTPException(status_code=502, detail=_LIBRARY_PLAYLIST_ERROR_DETAIL)

    try:
        playlists = await _run_library_playlist_provider(user_id, limit)
        if _is_current_library_playlist_flight(key, task, generation):
            _clear_library_playlist_error(key)
        items = []
        for p in playlists:
            pid = p.get("playlistId", "")
            if mixes_only:
                if pid in _SPECIAL_PLAYLIST_IDS:
                    continue
                if not any(pid.startswith(prefix) for prefix in _AUTO_PLAYLIST_PREFIXES):
                    continue
            items.append(
                {
                    "playlistId": pid,
                    "title": p.get("title", ""),
                    "description": p.get("description", ""),
                    "thumbnails": p.get("thumbnails", []),
                    "count": p.get("count"),
                }
            )
        return {"playlists": items, "total": len(items)}
    except _LibraryPlaylistProviderDeadlineError as error:
        raise HTTPException(
            status_code=504,
            detail=_LIBRARY_PLAYLIST_TIMEOUT_DETAIL,
        ) from error
    except HTTPException:
        raise
    except Exception as e:
        # Cache only ytmusicapi's provider HTTP 400. Transport timeouts and
        # connection failures may be transient, so every request may retry them.
        if _is_upstream_library_bad_request(e):
            if _is_current_library_playlist_flight(key, task, generation):
                _remember_library_playlist_error(key)
            raise _sanitized_http_error(
                f"Get library playlists for user {user_id}",
                e,
                502,
                _LIBRARY_PLAYLIST_ERROR_DETAIL,
            ) from e
        raise _sanitized_http_error(
            f"Get library playlists for user {user_id}",
            e,
            500,
            "Failed to load library playlists",
        ) from e
