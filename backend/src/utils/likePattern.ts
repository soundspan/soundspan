/**
 * Escapes SQL LIKE metacharacters so user input matches literally.
 * PostgreSQL defaults to backslash, but callers must pair the pattern with an
 * explicit `ESCAPE '\\'` clause.
 */
export const escapeLikePattern = (value: string): string =>
    value.replace(/[\\%_]/g, (character) => `\\${character}`);
