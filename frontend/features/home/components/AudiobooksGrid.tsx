"use client";

import Link from "next/link";
import Image from "next/image";
import { BookOpen } from "lucide-react";
import { api } from "@/lib/api";
import { Audiobook } from "../types";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { memo } from "react";

interface AudiobooksGridProps {
    audiobooks: Audiobook[];
}

interface AudiobookCardProps {
    audiobook: Audiobook;
    index: number;
}

const AudiobookCard = memo(function AudiobookCard({ 
    audiobook, 
    index 
}: AudiobookCardProps) {
    return (
        <CarouselItem>
            <Link
                href={`/audiobooks/${audiobook.id}`}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                <div className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors">
                    <div className="aspect-square bg-[#282828] rounded-full mb-3 flex items-center justify-center overflow-hidden relative shadow-lg">
                        {audiobook.coverUrl ? (
                            <Image
                                src={api.getCoverArtUrl(audiobook.coverUrl, 300)}
                                alt={audiobook.title}
                                fill
                                sizes="180px"
                                className="object-cover group-hover:scale-105 transition-transform duration-300"
                                unoptimized
                            />
                        ) : (
                            <BookOpen className="w-10 h-10 text-gray-600" />
                        )}
                    </div>
                    <h3 className="text-sm font-semibold text-white truncate">
                        {audiobook.title}
                    </h3>
                    <p className="text-xs text-gray-400 truncate mt-0.5">
                        {audiobook.author || "Audiobook"}
                    </p>
                </div>
            </Link>
        </CarouselItem>
    );
});

export function AudiobooksGrid({ audiobooks }: AudiobooksGridProps) {
    return (
        <HorizontalCarousel>
            {audiobooks.map((audiobook, index) => (
                <AudiobookCard 
                    key={audiobook.id} 
                    audiobook={audiobook} 
                    index={index} 
                />
            ))}
        </HorizontalCarousel>
    );
}
