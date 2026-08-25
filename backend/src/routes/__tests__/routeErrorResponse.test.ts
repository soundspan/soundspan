import type { Response } from "express";
import {
    sendRouteFailure,
    sendValidationError,
} from "../../utils/routeErrorResponse";

function createResponse(): Response {
    const response = {
        status: jest.fn(),
        json: jest.fn(),
    } as unknown as Response;
    (response.status as jest.Mock).mockReturnValue(response);
    (response.json as jest.Mock).mockReturnValue(response);
    return response;
}

describe("route error response helpers", () => {
    it("logs the exact route failure wording and sends its static 500 message", () => {
        const response = createResponse();
        const error = new Error("database detail");
        const log = { error: jest.fn() };

        sendRouteFailure(
            response,
            log,
            ["Clear downloads error:", "Failed to clear downloads"],
            error,
        );

        expect(log.error).toHaveBeenCalledWith("Clear downloads error:", error);
        expect(response.status).toHaveBeenCalledWith(500);
        expect(response.json).toHaveBeenCalledWith({
            error: "Failed to clear downloads",
        });
    });

    it("sends the supplied static validation message", () => {
        const response = createResponse();

        sendValidationError(
            response,
            { success: false },
            "Invalid federation request",
        );

        expect(response.status).toHaveBeenCalledWith(400);
        expect(response.json).toHaveBeenCalledWith({
            error: "Invalid federation request",
        });
    });
});
