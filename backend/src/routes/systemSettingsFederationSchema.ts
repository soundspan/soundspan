import { z } from "zod";

/** Optional administrator-controlled federation display name update. */
export const federationInstanceNameSchema = z
    .string()
    .trim()
    .max(100)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();
