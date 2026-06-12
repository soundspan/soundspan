/**
 * Supplemental OpenAPI coverage for legacy endpoint docs that still use
 * non-prefixed path keys.
 *
 * Keep this file focused on path-signature parity only.
 */

/**
 * @openapi
 * /api/api-keys:
 *   get:
 *     summary: List API keys for the current user.
 *     responses:
 *       "200":
 *         description: API keys returned.
 *   post:
 *     summary: Create a new API key.
 *     responses:
 *       "201":
 *         description: API key created.
 * /api/api-keys/{id}:
 *   delete:
 *     summary: Delete an API key by ID.
 *     responses:
 *       "200":
 *         description: API key deleted.
 * /api/auth/login:
 *   post:
 *     summary: Authenticate a user and create a session.
 *     responses:
 *       "200":
 *         description: Login successful.
 * /api/auth/me:
 *   get:
 *     summary: Return the authenticated user profile.
 *     responses:
 *       "200":
 *         description: Current user returned.
 * /api/library/scan:
 *   post:
 *     summary: Start a library scan.
 *     responses:
 *       "202":
 *         description: Scan accepted.
 * /api/listen-together:
 *   post:
 *     summary: Create a listen-together group.
 *     responses:
 *       "200":
 *         description: Group created.
 * /api/listen-together/join:
 *   post:
 *     summary: Join an existing listen-together group.
 *     responses:
 *       "200":
 *         description: Group joined.
 * /api/listen-together/discover:
 *   get:
 *     summary: Discover active listen-together groups.
 *     responses:
 *       "200":
 *         description: Groups returned.
 * /api/listen-together/active-count:
 *   get:
 *     summary: Get active listen-together group count.
 *     responses:
 *       "200":
 *         description: Count returned.
 * /api/listen-together/mine:
 *   get:
 *     summary: Get listen-together groups for the current user.
 *     responses:
 *       "200":
 *         description: User groups returned.
 * /api/listen-together/{groupId}/leave:
 *   post:
 *     summary: Leave a listen-together group.
 *     responses:
 *       "200":
 *         description: Left group.
 * /api/listen-together/{groupId}/end:
 *   post:
 *     summary: End a listen-together group.
 *     responses:
 *       "200":
 *         description: Group ended.
 * /api/lyrics/{trackId}:
 *   get:
 *     summary: Get lyrics for a track.
 *     responses:
 *       "200":
 *         description: Lyrics returned.
 *   delete:
 *     summary: Delete cached lyrics for a track.
 *     responses:
 *       "200":
 *         description: Lyrics cache deleted.
 * /api/mixes:
 *   get:
 *     summary: Get available mixes.
 *     responses:
 *       "200":
 *         description: Mixes returned.
 * /api/mixes/{id}:
 *   get:
 *     summary: Get a mix by ID.
 *     responses:
 *       "200":
 *         description: Mix returned.
 * /api/mixes/{id}/save:
 *   post:
 *     summary: Save a generated mix.
 *     responses:
 *       "200":
 *         description: Mix saved.
 * /api/mixes/mood:
 *   post:
 *     summary: Generate a mood mix.
 *     responses:
 *       "200":
 *         description: Mood mix generated.
 * /api/mixes/mood/buckets/presets:
 *   get:
 *     summary: List mood bucket presets.
 *     responses:
 *       "200":
 *         description: Presets returned.
 * /api/mixes/mood/buckets/{mood}:
 *   get:
 *     summary: Get tracks for a mood bucket.
 *     responses:
 *       "200":
 *         description: Mood bucket returned.
 * /api/mixes/mood/buckets/{mood}/save:
 *   post:
 *     summary: Save a mood bucket as a playlist.
 *     responses:
 *       "200":
 *         description: Mood bucket saved.
 * /api/mixes/mood/buckets/backfill:
 *   post:
 *     summary: Backfill mood bucket data.
 *     responses:
 *       "200":
 *         description: Mood bucket backfill queued.
 * /api/mixes/refresh:
 *   post:
 *     summary: Refresh generated mixes.
 *     responses:
 *       "200":
 *         description: Mix refresh started.
 * /api/search:
 *   get:
 *     summary: Search across the media library.
 *     responses:
 *       "200":
 *         description: Search results returned.
 * /health:
 *   get:
 *     summary: Health check endpoint.
 *     responses:
 *       "200":
 *         description: Service healthy.
 * /health/live:
 *   get:
 *     summary: Liveness check endpoint.
 *     responses:
 *       "200":
 *         description: Service is live.
 * /health/ready:
 *   get:
 *     summary: Readiness check endpoint.
 *     responses:
 *       "200":
 *         description: Service is ready.
 * /api/health:
 *   get:
 *     summary: API health check endpoint.
 *     responses:
 *       "200":
 *         description: API healthy.
 * /api/health/live:
 *   get:
 *     summary: API liveness check endpoint.
 *     responses:
 *       "200":
 *         description: API is live.
 * /api/health/ready:
 *   get:
 *     summary: API readiness check endpoint.
 *     responses:
 *       "200":
 *         description: API is ready.
 * /api/docs.json:
 *   get:
 *     summary: Return generated OpenAPI JSON.
 *     responses:
 *       "200":
 *         description: OpenAPI document returned.
 */
export {};
