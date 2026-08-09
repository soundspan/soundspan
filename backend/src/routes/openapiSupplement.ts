/**
 * Documents index.ts-level infrastructure endpoints (health/readiness probes
 * and the raw OpenAPI JSON route) that live outside any /api route module.
 * This file must not duplicate route-module documentation.
 */

/**
 * @openapi
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
