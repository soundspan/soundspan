import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { sendFileFromRoot } from "../sendFileFromRoot";

describe("sendFileFromRoot", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "soundspan-send-file-"),
        );
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("serves an image when the configured root contains a dotfile segment", async () => {
        const rootDir = path.join(tempDir, ".appdata", "covers");
        const filePath = path.join(rootDir, "browse", "thumbnail.img");
        const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, imageBytes);

        const app = express();
        app.get("/image", (_req, res) => {
            sendFileFromRoot(res, filePath, rootDir, {
                headers: { "Content-Type": "image/jpeg" },
            });
        });

        const response = await request(app).get("/image");

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toMatch(/^image\/jpeg\b/);
        expect(response.body).toEqual(imageBytes);
    });

    it("refuses to serve a file outside the configured root", async () => {
        const rootDir = path.join(tempDir, ".appdata", "covers");
        const secretPath = path.join(tempDir, "secret.txt");
        fs.mkdirSync(rootDir, { recursive: true });
        fs.writeFileSync(secretPath, "must-not-leak");

        const app = express();
        app.get("/escape", (_req, res) => {
            sendFileFromRoot(res, secretPath, rootDir);
        });

        const response = await request(app).get("/escape");

        expect(response.status).toBe(404);
        expect(response.text).not.toContain("must-not-leak");
    });
});
