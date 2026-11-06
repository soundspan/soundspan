/**
 * `SECURE_COOKIES` policy for soundspan's own cookies (the OIDC flow cookie,
 * the queue-dashboard cookie, and the backup-download cookie).
 *
 * `"auto"` (the default) follows the scheme the browser used, as Express
 * reports it in `req.secure`: behind the configured `trust proxy` chain this
 * is the first `X-Forwarded-Proto` value, so a TLS-terminating proxy yields
 * `Secure` cookies and a plain-HTTP install yields cookies the browser keeps.
 * An explicit `true` or `false` overrides the request.
 */
export type SecureCookieSetting = boolean | "auto";

/** The part of an Express request this policy reads. */
export interface SecureCookieRequest {
    secure: boolean;
}

/** Parse `SECURE_COOKIES`; unset, blank, `auto`, or unrecognized means auto. */
export function parseSecureCookieSetting(
    raw: string | undefined,
): SecureCookieSetting {
    if (typeof raw !== "string") return "auto";
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    return "auto";
}

/** Decide whether one request's cookie should carry the `Secure` attribute. */
export function shouldUseSecureCookie(
    setting: SecureCookieSetting,
    req: SecureCookieRequest,
): boolean {
    if (setting === "auto") return req.secure === true;
    return setting;
}

/** Apply a `__Secure-`/`__Host-` name prefix only when the cookie is Secure. */
export function secureCookiePrefixedName(
    baseName: string,
    prefix: "__Secure-" | "__Host-",
    secure: boolean,
): string {
    return secure ? `${prefix}${baseName}` : baseName;
}
