import type { AliasInfo } from "../types";

interface AliasResolutionBannerProps {
    aliasInfo: AliasInfo;
}

export function AliasResolutionBanner({ aliasInfo }: AliasResolutionBannerProps) {
    return (
        <div className="text-sm text-[#b3b3b3] mb-4">
            Showing results for{" "}
            <span className="text-white font-medium">{aliasInfo.canonical}</span>
            {" "}(searched &quot;{aliasInfo.original}&quot;)
        </div>
    );
}
