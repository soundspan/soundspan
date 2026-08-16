/**
 * @openapi
 * /rest/*:
 *   all:
 *     summary: Catch-all for unsupported Subsonic endpoints
 *     tags: [Subsonic]
 *     responses:
 *       200:
 *         description: Subsonic error response indicating endpoint not supported
 */
export { default } from "./subsonic/index";
export * from "./subsonic/index";
