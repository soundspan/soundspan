const mockOn = jest.fn();
const mockMetricsJson = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerDebug = jest.fn();

const mockPrisma: any = {
    $on: (...args: unknown[]) => mockOn(...args),
    $metrics: {
        json: (...args: unknown[]) => mockMetricsJson(...args),
    },
};

jest.mock("../db", () => ({
    prisma: mockPrisma,
}));

jest.mock("../logger", () => ({
    logger: {
        warn: (...args: unknown[]) => mockLoggerWarn(...args),
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
    },
}));

import { enableSlowQueryMonitoring, logQueryStats } from "../queryMonitor";

describe("queryMonitor", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockPrisma.$metrics = {
            json: (...args: unknown[]) => mockMetricsJson(...args),
        };
    });

    it("registers slow query logging and warns only above threshold", async () => {
        enableSlowQueryMonitoring();

        expect(mockOn).toHaveBeenCalledTimes(1);
        expect(mockOn).toHaveBeenCalledWith("query", expect.any(Function));
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "Slow query monitoring enabled (threshold: 100ms)"
        );

        const handler = mockOn.mock.calls[0][1];
        await handler({
            duration: 150,
            query: "SELECT * FROM artists",
            params: "[]",
        });
        await handler({
            duration: 75,
            query: "SELECT 1",
            params: "[]",
        });

        expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            expect.stringContaining("Slow query detected (150ms)")
        );
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            expect.stringContaining("Query: SELECT * FROM artists")
        );
    });

    it("logs query stats from prisma metrics", async () => {
        const stats = { counters: { queries: 42 } };
        mockMetricsJson.mockResolvedValueOnce(stats);

        await logQueryStats();

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "Database Query Stats:",
            JSON.stringify(stats, null, 2)
        );
    });

    it("handles missing prisma metrics gracefully", async () => {
        mockPrisma.$metrics = undefined;

        await logQueryStats();

        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "Database Query Stats:",
            undefined
        );
    });
});

