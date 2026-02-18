export const BRAND_NAME = "soundspan";
export const BRAND_SLUG = "soundspan";
export const BRAND_SITE_URL = "https://soundspan.io";
export const BRAND_REPOSITORY_URL = "https://github.com/soundspan/soundspan";
export const BRAND_API_TITLE = `${BRAND_NAME} API`;
export const BRAND_API_DOCS_TITLE = `${BRAND_NAME} API Documentation`;
export const BRAND_API_DESCRIPTION =
    "Self-hosted music streaming server with Discover Weekly and full-text search";

const BRAND_RUNTIME_VERSION = process.env.npm_package_version || "1.0.0";
export const BRAND_USER_AGENT = `${BRAND_NAME}/${BRAND_RUNTIME_VERSION} (${BRAND_REPOSITORY_URL})`;
