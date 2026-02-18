"use client";

import DOMPurify from "dompurify";
import { useMemo, useState } from "react";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { cn } from "@/utils/cn";

interface ArtistBioProps {
  bio: string;
}

export function ArtistBio({ bio }: ArtistBioProps) {
  const safeBio = bio || "";
  const isMobile = useIsMobile();
  const [expandedBio, setExpandedBio] = useState<string | null>(null);
  const isExpanded = expandedBio === safeBio;

  const plainBio = useMemo(
    () => safeBio.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
    [safeBio]
  );
  const needsCollapse = isMobile && plainBio.length > 260;
  const shouldCollapse = needsCollapse && !isExpanded;

  if (!safeBio) return null;

  return (
    <section>
      <h2 className="text-xl font-bold mb-4">About</h2>
      <div className="bg-white/5 rounded-md p-4">
        <div
          className={cn(
            "prose prose-sm md:prose-base prose-invert max-w-none leading-relaxed [&_a]:text-[#3b82f6] [&_a]:no-underline [&_a:hover]:underline",
            shouldCollapse && "max-h-28 overflow-hidden"
          )}
          style={{ color: "#b3b3b3" }}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(safeBio) }}
        />
        {shouldCollapse && (
          <div className="-mt-12 h-12 bg-gradient-to-t from-[#181818] to-transparent" />
        )}
        {needsCollapse && !isExpanded && (
          <button
            type="button"
            onClick={() => setExpandedBio(safeBio)}
            className="mt-2 text-sm text-[#3b82f6] hover:underline"
          >
            ...more
          </button>
        )}
      </div>
    </section>
  );
}
