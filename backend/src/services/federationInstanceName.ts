import { config } from "../config";
import { getSystemSettings } from "../utils/systemSettings";

/** Resolves the administrator-set federation name with the host fallback. */
export async function resolveFederationInstanceName(): Promise<string> {
    const settings = await getSystemSettings();
    const configuredName = settings?.federationInstanceName?.trim();
    return configuredName || config.federation.instanceName;
}
