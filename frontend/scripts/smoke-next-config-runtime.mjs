import configModule from "next/dist/server/config.js";
import { PHASE_PRODUCTION_SERVER } from "next/constants.js";

const loadConfig = configModule.default;

await loadConfig(PHASE_PRODUCTION_SERVER, process.cwd());
