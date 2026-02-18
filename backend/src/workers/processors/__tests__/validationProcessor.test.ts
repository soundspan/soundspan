const mockLoggerDebug = jest.fn();
const mockValidateLibrary = jest.fn();
const mockFileValidatorService = jest.fn(() => ({
    validateLibrary: mockValidateLibrary,
}));

jest.mock("../../../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
    },
}));

jest.mock("../../../services/fileValidator", () => ({
    FileValidatorService: mockFileValidatorService,
}));

import { processValidation } from "../validationProcessor";
import { FileValidatorService } from "../../../services/fileValidator";

describe("validationProcessor", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("runs validation workflow and reports progress", async () => {
        const result = {
            tracksChecked: 50,
            tracksRemoved: 4,
            tracksMissing: ["/missing/a.mp3"],
            duration: 1234,
        };
        mockValidateLibrary.mockResolvedValueOnce(result);

        const job = {
            id: "validation-1",
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        const actual = await processValidation(job);

        expect(FileValidatorService).toHaveBeenCalledTimes(1);
        expect(mockValidateLibrary).toHaveBeenCalledTimes(1);
        expect(job.progress).toHaveBeenCalledTimes(2);
        expect(job.progress).toHaveBeenNthCalledWith(1, 0);
        expect(job.progress).toHaveBeenNthCalledWith(2, 100);
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[ValidationJob validation-1] Starting file validation"
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[ValidationJob validation-1] Validation complete: 4 tracks removed"
        );
        expect(actual).toEqual(result);
    });

    it("propagates validator errors after initial progress update", async () => {
        const error = new Error("validation failed");
        mockValidateLibrary.mockRejectedValueOnce(error);

        const job = {
            id: "validation-2",
            progress: jest.fn().mockResolvedValue(undefined),
        } as any;

        await expect(processValidation(job)).rejects.toThrow("validation failed");
        expect(job.progress).toHaveBeenCalledTimes(1);
        expect(job.progress).toHaveBeenCalledWith(0);
    });
});
