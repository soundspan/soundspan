// Tier distribution for variety in recommendations
// This ensures each playlist has a mix of similarity levels
/** Target recommendation distribution across similarity tiers. */
export const TIER_DISTRIBUTION = {
    high: 0.3, // 30% from very similar artists (>80% match)
    medium: 0.4, // 40% from moderately similar (50-80% match)
    explore: 0.2, // 20% from stretch picks (30-50% match)
    wildcard: 0.1, // 10% from genre tags (variety)
};

/**
 * Calculate tier from Last.fm similarity score
 * Last.fm typically returns scores in 0.5-0.9 range for similar artists
 * Adjusted thresholds for better distribution:
 * - High Match: 60-100% (0.6-1.0)
 * - Medium Match: 45-59% (0.45-0.59)
 * - Explore: 30-44% (0.3-0.44)
 * - Wild Card: 0-29% (0-0.29) or explicitly set
 */
export function getTierFromSimilarity(
    similarity: number,
): "high" | "medium" | "explore" | "wildcard" {
    if (similarity >= 0.6) return "high";
    if (similarity >= 0.45) return "medium";
    if (similarity >= 0.3) return "explore";
    return "wildcard";
}
