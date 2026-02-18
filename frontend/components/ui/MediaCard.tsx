import React, { memo } from "react";
import Link from "next/link";
import Image from "next/image";

interface MediaCardProps {
    href: string;
    imageUrl: string | null | undefined;
    title: string;
    subtitle?: string;
    placeholderIcon: React.ReactNode;
    onClick?: (e: React.MouseEvent) => void;
    badge?: React.ReactNode;
    imageShape?: "circle" | "square";
}

const MediaCard = memo(function MediaCard({
    href,
    imageUrl,
    title,
    subtitle,
    placeholderIcon,
    onClick,
    badge,
    imageShape = "circle",
}: MediaCardProps) {
    const content = (
        <div
            className="bg-[#121212] hover:bg-[#181818] p-4 rounded-lg cursor-pointer transition-colors group"
            onClick={onClick}
        >
            <div
                className={`aspect-square bg-[#181818] ${
                    imageShape === "circle" ? "rounded-full" : "rounded-md"
                } mb-4 flex items-center justify-center overflow-hidden relative shadow-lg`}
                style={{ contain: "content" }}
            >
                {imageUrl ? (
                    <Image
                        src={imageUrl}
                        alt={title}
                        fill
                        className="object-cover group-hover:scale-105 transition-transform"
                        sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, (max-width: 1280px) 20vw, 16vw"
                        priority={false}
                        unoptimized
                    />
                ) : (
                    placeholderIcon
                )}
            </div>
            <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-bold text-white line-clamp-1 mb-2">
                        {title}
                    </h3>
                    {subtitle && (
                        <p className="text-sm text-gray-400 line-clamp-1">
                            {subtitle}
                        </p>
                    )}
                </div>
                {badge && <div className="flex-shrink-0">{badge}</div>}
            </div>
        </div>
    );

    if (onClick) {
        return content;
    }

    return <Link href={href}>{content}</Link>;
});

export { MediaCard };
