/**
 * Discovery Batch Logger
 *
 * Handles logging for discovery batch operations with database persistence.
 */

import { prisma } from '../../utils/db';
import { logger } from '../../utils/logger';

export interface BatchLogEntry {
    timestamp: string;
    level: 'info' | 'warn' | 'error';
    message: string;
}

export class DiscoveryBatchLogger {
    private readonly MAX_LOG_ENTRIES = 100;

    /**
     * Add a log entry to a discovery batch
     */
    async addLog(
        batchId: string,
        level: 'info' | 'warn' | 'error',
        message: string
    ): Promise<void> {
        try {
            const batch = await prisma.discoveryBatch.findUnique({
                where: { id: batchId },
                select: { logs: true },
            });

            const logs = (batch?.logs as unknown as BatchLogEntry[]) || [];
            logs.push({
                timestamp: new Date().toISOString(),
                level,
                message,
            });

            const trimmedLogs = logs.slice(-this.MAX_LOG_ENTRIES);

            await prisma.discoveryBatch.update({
                where: { id: batchId },
                data: { logs: trimmedLogs as any },
            });
        } catch (error) {
            logger.error('Failed to add batch log:', error);
        }
    }

    async info(batchId: string, message: string): Promise<void> {
        return this.addLog(batchId, 'info', message);
    }

    async warn(batchId: string, message: string): Promise<void> {
        return this.addLog(batchId, 'warn', message);
    }

    async error(batchId: string, message: string): Promise<void> {
        return this.addLog(batchId, 'error', message);
    }
}

export const discoveryBatchLogger = new DiscoveryBatchLogger();
