import type { Prisma } from "@prisma/client";
import {
    LOCAL_TRACK_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../../utils/librarySorting";

/** Active tracks physically owned by this soundspan instance. */
export const VISIBLE_LOCAL_TRACK_WHERE = {
    ...TRACK_VISIBLE_WHERE,
    ...LOCAL_TRACK_WHERE,
} satisfies Prisma.TrackWhereInput;
