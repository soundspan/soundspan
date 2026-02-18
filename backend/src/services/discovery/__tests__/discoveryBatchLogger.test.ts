import { DiscoveryBatchLogger, BatchLogEntry } from '../discoveryBatchLogger';
import { prisma } from '../../../utils/db';

jest.mock('../../../utils/db', () => ({
    prisma: {
        discoveryBatch: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
    },
}));

describe('DiscoveryBatchLogger', () => {
    const mockPrisma = prisma as jest.Mocked<typeof prisma>;

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('addLog', () => {
        it('should append log entry to existing logs', async () => {
            const existingLogs: BatchLogEntry[] = [
                { timestamp: '2024-01-01T00:00:00Z', level: 'info', message: 'Started' },
            ];

            (mockPrisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({
                id: 'batch-123',
                logs: existingLogs,
            });

            (mockPrisma.discoveryBatch.update as jest.Mock).mockResolvedValue({});

            const logger = new DiscoveryBatchLogger();
            await logger.addLog('batch-123', 'info', 'Test message');

            expect(mockPrisma.discoveryBatch.update).toHaveBeenCalledWith({
                where: { id: 'batch-123' },
                data: {
                    logs: expect.arrayContaining([
                        expect.objectContaining({ level: 'info', message: 'Test message' }),
                    ]),
                },
            });
        });

        it('should trim logs to 100 entries max', async () => {
            const existingLogs: BatchLogEntry[] = Array.from({ length: 100 }, (_, i) => ({
                timestamp: new Date().toISOString(),
                level: 'info' as const,
                message: `Log ${i}`,
            }));

            (mockPrisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({
                id: 'batch-123',
                logs: existingLogs,
            });

            (mockPrisma.discoveryBatch.update as jest.Mock).mockResolvedValue({});

            const logger = new DiscoveryBatchLogger();
            await logger.addLog('batch-123', 'info', 'New log');

            const updateCall = (mockPrisma.discoveryBatch.update as jest.Mock).mock.calls[0][0];
            expect((updateCall.data.logs as BatchLogEntry[]).length).toBe(100);
        });

        it('should handle missing batch gracefully', async () => {
            (mockPrisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue(null);
            (mockPrisma.discoveryBatch.update as jest.Mock).mockResolvedValue({});

            const logger = new DiscoveryBatchLogger();
            await logger.addLog('batch-123', 'info', 'Test message');

            expect(mockPrisma.discoveryBatch.update).toHaveBeenCalledWith({
                where: { id: 'batch-123' },
                data: {
                    logs: [expect.objectContaining({ level: 'info', message: 'Test message' })],
                },
            });
        });

        it('should not throw when database operation fails', async () => {
            (mockPrisma.discoveryBatch.findUnique as jest.Mock).mockRejectedValue(
                new Error('Database error')
            );

            const logger = new DiscoveryBatchLogger();
            await expect(logger.addLog('batch-123', 'error', 'Test')).resolves.not.toThrow();
        });
    });

    describe('convenience methods', () => {
        it('info() should call addLog with info level', async () => {
            (mockPrisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({ logs: [] });
            (mockPrisma.discoveryBatch.update as jest.Mock).mockResolvedValue({});

            const logger = new DiscoveryBatchLogger();
            await logger.info('batch-123', 'Info message');

            expect(mockPrisma.discoveryBatch.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: {
                        logs: [expect.objectContaining({ level: 'info', message: 'Info message' })],
                    },
                })
            );
        });

        it('warn() should call addLog with warn level', async () => {
            (mockPrisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({ logs: [] });
            (mockPrisma.discoveryBatch.update as jest.Mock).mockResolvedValue({});

            const logger = new DiscoveryBatchLogger();
            await logger.warn('batch-123', 'Warning message');

            expect(mockPrisma.discoveryBatch.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: {
                        logs: [expect.objectContaining({ level: 'warn', message: 'Warning message' })],
                    },
                })
            );
        });

        it('error() should call addLog with error level', async () => {
            (mockPrisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({ logs: [] });
            (mockPrisma.discoveryBatch.update as jest.Mock).mockResolvedValue({});

            const logger = new DiscoveryBatchLogger();
            await logger.error('batch-123', 'Error message');

            expect(mockPrisma.discoveryBatch.update).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: {
                        logs: [expect.objectContaining({ level: 'error', message: 'Error message' })],
                    },
                })
            );
        });
    });
});
