/**
 * Shared enter/exit motion for the overlay drawer tab panels (GH #787).
 * Every tab uses the same slide-fade so switching tabs feels like one
 * surface; reduced motion pins the panels in place.
 */
export function buildTabTransitionProps(shouldReduceMotion: boolean | null) {
    if (shouldReduceMotion) {
        return {
            initial: { opacity: 1, y: 0 },
            animate: { opacity: 1, y: 0 },
            exit: { opacity: 1, y: 0 },
            transition: { duration: 0 },
        };
    }
    return {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -8 },
        transition: { duration: 0.18 },
    };
}
