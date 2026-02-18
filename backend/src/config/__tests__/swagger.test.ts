describe("config/swagger", () => {
    beforeEach(() => {
        jest.resetModules();
    });

    test("builds swagger options from config and exports generated spec", () => {
        const mockedSpec = { mocked: "swagger-spec" };
        const swaggerJsdoc = jest.fn(() => mockedSpec);

        jest.doMock("swagger-jsdoc", () => swaggerJsdoc);
        jest.doMock("../../config", () => ({
            config: {
                port: 9876,
            },
        }));

        const { swaggerSpec } = require("../swagger");

        expect(swaggerJsdoc).toHaveBeenCalledTimes(1);
        expect(swaggerJsdoc).toHaveBeenCalledWith(
            expect.objectContaining({
                definition: expect.objectContaining({
                    openapi: "3.0.0",
                    servers: [
                        expect.objectContaining({
                            url: "http://localhost:9876",
                        }),
                    ],
                    components: expect.objectContaining({
                        securitySchemes: expect.objectContaining({
                            sessionAuth: expect.objectContaining({
                                type: "apiKey",
                                in: "cookie",
                                name: "connect.sid",
                            }),
                            apiKeyAuth: expect.objectContaining({
                                type: "apiKey",
                                in: "header",
                                name: "X-API-Key",
                            }),
                        }),
                    }),
                }),
                apis: ["./src/routes/*.ts", "./src/config/swaggerSchemas.ts"],
            })
        );
        expect(swaggerSpec).toBe(mockedSpec);
    });
});
