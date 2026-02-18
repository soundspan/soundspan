import { logger } from "../utils/logger";
import { runDataIntegrityCheck } from "./dataIntegrity";

runDataIntegrityCheck()
    .then(() => {
        logger.debug("\nData integrity check completed successfully");
        process.exit(0);
    })
    .catch((err) => {
        logger.error("\n Data integrity check failed:", err);
        process.exit(1);
    });
