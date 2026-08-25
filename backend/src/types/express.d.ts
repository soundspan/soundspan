import type { Pagination } from "../middleware/parsePagination";
import type { OwnedResource } from "../middleware/loadOwned";

declare global {
    namespace Express {
        interface Request {
            valid?: {
                body?: unknown;
                query?: unknown;
                params?: unknown;
            };
            pagination?: Pagination;
            owned?: OwnedResource;
        }
    }
}

export {};
