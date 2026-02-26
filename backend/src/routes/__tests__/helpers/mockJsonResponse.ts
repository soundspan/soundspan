export interface MockJsonResponse<T = any> {
    statusCode: number;
    body: T | undefined;
    status: jest.MockedFunction<(code: number) => MockJsonResponse<T>>;
    json: jest.MockedFunction<(payload: T) => MockJsonResponse<T>>;
}

export function createMockJsonResponse<T = any>(): MockJsonResponse<T> {
    const res: MockJsonResponse<T> = {
        statusCode: 200,
        body: undefined,
        status: jest.fn((code: number) => {
            res.statusCode = code;
            return res;
        }) as MockJsonResponse<T>["status"],
        json: jest.fn((payload: T) => {
            res.body = payload;
            return res;
        }) as MockJsonResponse<T>["json"],
    };

    return res;
}
