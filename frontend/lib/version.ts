import packageJson from "../package.json";

// Base version from build-time env override, falling back to package.json
const rawConfiguredVersion = process.env.NEXT_PUBLIC_APP_VERSION?.trim();
const BASE_VERSION = rawConfiguredVersion || packageJson.version;
const NORMALIZED_BASE_VERSION = BASE_VERSION.startsWith("v")
    ? BASE_VERSION.slice(1)
    : BASE_VERSION;

// Check if this is a nightly build (set via NEXT_PUBLIC_BUILD_TYPE env var)
const isNightly = process.env.NEXT_PUBLIC_BUILD_TYPE === "nightly";
const alreadyNightly = NORMALIZED_BASE_VERSION.endsWith("-nightly");

// Export version with nightly suffix if applicable
export const APP_VERSION =
    isNightly && !alreadyNightly
        ? `${NORMALIZED_BASE_VERSION}-nightly`
        : NORMALIZED_BASE_VERSION;
