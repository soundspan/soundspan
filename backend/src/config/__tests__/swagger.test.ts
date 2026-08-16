describe("config/swagger", () => {
    beforeEach(() => {
        jest.resetModules();
    });

    test("builds swagger options from config and exports generated spec", () => {
        const mockedSpec = { mocked: "swagger-spec" };
        const swaggerJsdoc = jest.fn((_options: unknown) => mockedSpec);

        jest.doMock("swagger-jsdoc", () => swaggerJsdoc);
        jest.doMock("../../config", () => ({
            config: {
                port: 9876,
            },
        }));

        const { swaggerSpec } = require("../swagger");
        const generatedOptions = swaggerJsdoc.mock.calls[0]?.[0] as {
            definition: {
                components: { securitySchemes: Record<string, unknown> };
            };
        };

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
                            apiKeyAuth: expect.objectContaining({
                                type: "apiKey",
                                in: "header",
                                name: "X-API-Key",
                            }),
                        }),
                    }),
                    security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
                }),
                apis: [
                    "./src/routes/*.ts",
                    "./src/routes/auth/*.ts",
                    "./src/routes/library/*.ts",
                ],
            }),
        );
        expect(
            generatedOptions.definition.components.securitySchemes,
        ).not.toHaveProperty("sessionAuth");
        expect(swaggerSpec).toBe(mockedSpec);
    });
});
