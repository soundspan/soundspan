import express, { Router } from "express";

export function createRouteTestApp(basePath: string, router: Router) {
    const app = express();
    app.use(express.json());
    app.use(basePath, router);
    return app;
}
