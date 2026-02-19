"use client";

import { Sparkles, ChevronRight } from "lucide-react";
import { Card } from "@/components/ui/Card";

export function HowItWorks() {
    return (
        <Card className="p-6 bg-[#111]/50  border-white/5">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2 text-white">
                <Sparkles className="w-5 h-5 text-[#5b5bff]" />
                How It Works
            </h3>
            <div className="space-y-3 text-sm text-gray-400">
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-[#5b5bff]/60 shrink-0" />
                    <p>
                        Builds recommendations from your listening history and local library first.
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-[#5b5bff]/60 shrink-0" />
                    <p>
                        Similarity tiers keep a mix of safe picks and exploration tracks.
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-[#5b5bff]/60 shrink-0" />
                    <p>
                        When TIDAL or YouTube Music is connected, a portion of tracks can stream via gap-fill.
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-[#5b5bff]/60 shrink-0" />
                    <p>
                        Source badges show whether each track is Local, TIDAL, or YouTube Music.
                    </p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-[#5b5bff]/60 shrink-0" />
                    <p>Albums won&apos;t repeat for 6 months</p>
                </div>
                <div className="flex items-start gap-3">
                    <ChevronRight className="w-4 h-4 mt-0.5 text-[#5b5bff]/60 shrink-0" />
                    <p>
                        No automatic downloads or library writes are performed by this flow.
                    </p>
                </div>
            </div>
        </Card>
    );
}
