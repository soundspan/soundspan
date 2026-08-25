import type { Request, Response } from "express";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { sendInternalRouteError } from "../../utils/routeErrorResponse";

type NumericInput = string | number;

interface DiscoverConfigUpdateBody {
    playlistSize?: NumericInput;
    maxRetryAttempts?: NumericInput;
    exclusionMonths?: NumericInput;
    downloadRatio?: NumericInput;
    enabled?: boolean;
}

function parseInteger(value: NumericInput): number {
    return Number.parseInt(String(value), 10);
}

function validateInteger(
    value: NumericInput | undefined,
    minimum: number,
    maximum: number,
    increment = 1,
): boolean {
    if (value === undefined) return true;
    const parsed = parseInteger(value);
    return (
        Number.isFinite(parsed) &&
        parsed >= minimum &&
        parsed <= maximum &&
        parsed % increment === 0
    );
}

function validateRatio(value: NumericInput | undefined): boolean {
    if (value === undefined) return true;
    const parsed = Number.parseFloat(String(value));
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= 2;
}

function validationError(body: DiscoverConfigUpdateBody): string | null {
    if (!validateInteger(body.playlistSize, 5, 50, 5)) {
        return "Invalid playlist size. Must be between 5-50 in increments of 5.";
    }
    if (!validateInteger(body.maxRetryAttempts, 1, 10)) {
        return "Invalid retry attempts. Must be between 1-10.";
    }
    if (!validateInteger(body.exclusionMonths, 0, 12)) {
        return "Invalid exclusion months. Must be between 0-12.";
    }
    if (!validateRatio(body.downloadRatio)) {
        return "Invalid download ratio. Must be between 1.0-2.0.";
    }
    return null;
}

function parsedUpdates(body: DiscoverConfigUpdateBody) {
    return {
        ...(body.playlistSize !== undefined && {
            playlistSize: parseInteger(body.playlistSize),
        }),
        ...(body.maxRetryAttempts !== undefined && {
            maxRetryAttempts: parseInteger(body.maxRetryAttempts),
        }),
        ...(body.exclusionMonths !== undefined && {
            exclusionMonths: parseInteger(body.exclusionMonths),
        }),
        ...(body.downloadRatio !== undefined && {
            downloadRatio: Number.parseFloat(String(body.downloadRatio)),
        }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
    };
}

/** Returns the current user's discovery configuration. */
export async function handleGetDiscoverConfig(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const userId = req.user!.id;
        let discoverConfig = await prisma.userDiscoverConfig.findUnique({
            where: { userId },
        });
        if (!discoverConfig) {
            discoverConfig = await prisma.userDiscoverConfig.create({
                data: {
                    userId,
                    playlistSize: 10,
                    maxRetryAttempts: 3,
                    exclusionMonths: 6,
                    downloadRatio: 1.3,
                    enabled: true,
                },
            });
        }
        return res.json(discoverConfig);
    } catch (error) {
        logger.error("Get Discover Weekly config error:", error);
        sendInternalRouteError(res, "Failed to get configuration");
    }
}

/** Updates the current user's discovery configuration. */
export async function handleUpdateDiscoverConfig(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const userId = req.user!.id;
        const body = req.body as DiscoverConfigUpdateBody;
        const errorMessage = validationError(body);
        if (errorMessage) return res.status(400).json({ error: errorMessage });

        const discoverConfig = await prisma.userDiscoverConfig.upsert({
            where: { userId },
            create: {
                userId,
                playlistSize: (body.playlistSize ?? 10) as number,
                maxRetryAttempts: (body.maxRetryAttempts ?? 3) as number,
                exclusionMonths: (body.exclusionMonths ?? 6) as number,
                downloadRatio: (body.downloadRatio ?? 1.3) as number,
                enabled: body.enabled ?? true,
            },
            update: parsedUpdates(body),
        });
        return res.json(discoverConfig);
    } catch (error) {
        logger.error("Update Discover Weekly config error:", error);
        sendInternalRouteError(res, "Failed to update configuration");
    }
}
