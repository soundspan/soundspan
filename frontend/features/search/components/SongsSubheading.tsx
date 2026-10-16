import type { ReactNode } from "react";

interface SongsSubheadingProps {
    id?: string;
    children: ReactNode;
}

/** Small heading that separates the groups inside the search Songs section. */
export function SongsSubheading({ id, children }: SongsSubheadingProps) {
    return (
        <h3 id={id} className="mb-2 px-3 text-sm font-semibold text-gray-300">
            {children}
        </h3>
    );
}
