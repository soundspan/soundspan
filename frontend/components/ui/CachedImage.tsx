"use client";

import Image, { ImageProps } from "next/image";
import { memo } from "react";

interface CachedImageProps extends Omit<ImageProps, "src"> {
    src: string | null | undefined;
    fill?: boolean;
}

/**
 * Image component with Service Worker caching
 * The SW handles cache-first fetching for /api/library/cover-art/* routes
 */
const CachedImage = memo(function CachedImage({
    src,
    alt = "",
    ...props
}: CachedImageProps) {
    if (!src) {
        return null;
    }

    // Add lazy loading by default for better performance
    const imageProps = {
        ...props,
        loading: props.loading || 'lazy',
    };

    return <Image src={src} alt={alt} unoptimized {...imageProps} />;
});

export { CachedImage };
export type { CachedImageProps };
