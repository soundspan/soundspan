import { Music2 } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";

export function LibraryHeader() {
  return (
    <div className="relative">
      {/* Background gradient */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute inset-0 bg-gradient-to-b from-[#3b82f6]/15 via-blue-900/10 to-transparent"
          style={{ height: "35vh" }}
        />
        <div
          className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-[#3b82f6]/8 via-transparent to-transparent"
          style={{ height: "25vh" }}
        />
      </div>

      {/* Compact header */}
      <div className="relative px-4 md:px-8 py-6">
        <PageHeader
          title="Your Library"
          subtitle="Your music collection"
          icon={Music2}
          className="mb-0"
        />
      </div>
    </div>
  );
}
