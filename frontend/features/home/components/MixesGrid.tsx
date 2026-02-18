"use client";

import { MixCard } from "@/components/MixCard";
import { Mix } from "../types";
import { memo } from "react";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";

interface MixesGridProps {
    mixes: Mix[];
}

const MixesGrid = memo(function MixesGrid({ mixes }: MixesGridProps) {
    return (
        <HorizontalCarousel>
            {mixes.map((mix, index) => (
                <CarouselItem key={mix.id}>
                    <MixCard mix={mix} index={index} />
                </CarouselItem>
            ))}
        </HorizontalCarousel>
    );
});

export { MixesGrid };
