export interface AutoMatchVibeQueueEndInput {
    playbackType: "track" | "audiobook" | "podcast" | null;
    queueLength: number;
    currentIndex: number;
    repeatMode: "off" | "one" | "all";
    isListenTogether: boolean;
}

export function shouldAutoMatchVibeAtQueueEnd(
    input: AutoMatchVibeQueueEndInput
): boolean {
    if (input.playbackType !== "track") return false;
    if (input.isListenTogether) return false;
    if (input.repeatMode !== "off") return false;
    if (input.queueLength <= 0) return false;
    return input.currentIndex >= input.queueLength - 1;
}
