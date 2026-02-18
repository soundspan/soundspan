// backend/src/config/featureProfiles.ts

/**
 * Research-based audio feature profiles for genres, moods, and vibes.
 * Values are target ranges (0-1) based on academic literature on music information retrieval.
 *
 * Sources:
 * - Tzanetakis & Cook (2002) - Musical genre classification
 * - Laurier et al. (2008) - Audio music mood classification
 * - Spotify Audio Features documentation
 */

export interface FeatureProfile {
    energy?: number;
    valence?: number;
    danceability?: number;
    acousticness?: number;
    instrumentalness?: number;
    arousal?: number;
    speechiness?: number;
}

export type TermType = "genre" | "mood" | "vibe" | "descriptor";

export interface VocabTermDefinition {
    type: TermType;
    featureProfile: FeatureProfile;
    related?: string[];
}

export const VOCAB_DEFINITIONS: Record<string, VocabTermDefinition> = {
    // === GENRES ===
    electronic: {
        type: "genre",
        featureProfile: { instrumentalness: 0.7, acousticness: 0.15, danceability: 0.7, energy: 0.65 },
        related: ["synth", "edm", "techno", "house", "trance"]
    },
    techno: {
        type: "genre",
        featureProfile: { instrumentalness: 0.85, acousticness: 0.1, danceability: 0.8, energy: 0.75 },
        related: ["electronic", "house", "minimal"]
    },
    house: {
        type: "genre",
        featureProfile: { instrumentalness: 0.6, acousticness: 0.1, danceability: 0.85, energy: 0.7 },
        related: ["electronic", "disco", "dance"]
    },
    trance: {
        type: "genre",
        featureProfile: { instrumentalness: 0.8, acousticness: 0.1, danceability: 0.75, energy: 0.7, arousal: 0.65 },
        related: ["electronic", "edm"]
    },
    ambient: {
        type: "genre",
        featureProfile: { instrumentalness: 0.9, acousticness: 0.4, energy: 0.2, arousal: 0.2, danceability: 0.15 },
        related: ["electronic", "atmospheric", "chill"]
    },
    trap: {
        type: "genre",
        featureProfile: { instrumentalness: 0.3, acousticness: 0.1, danceability: 0.7, energy: 0.7 },
        related: ["hip-hop", "rap", "electronic"]
    },
    "hip-hop": {
        type: "genre",
        featureProfile: { instrumentalness: 0.2, acousticness: 0.15, danceability: 0.75, speechiness: 0.3 },
        related: ["rap", "trap", "r&b"]
    },
    rock: {
        type: "genre",
        featureProfile: { instrumentalness: 0.3, acousticness: 0.25, energy: 0.75, danceability: 0.5 },
        related: ["alternative", "indie", "punk"]
    },
    metal: {
        type: "genre",
        featureProfile: { instrumentalness: 0.4, acousticness: 0.05, energy: 0.95, arousal: 0.9, valence: 0.3 },
        related: ["heavy", "hard rock"]
    },
    punk: {
        type: "genre",
        featureProfile: { instrumentalness: 0.2, acousticness: 0.2, energy: 0.9, danceability: 0.5, valence: 0.5 },
        related: ["rock", "alternative"]
    },
    jazz: {
        type: "genre",
        featureProfile: { instrumentalness: 0.6, acousticness: 0.7, danceability: 0.5, energy: 0.4 },
        related: ["blues", "soul", "swing"]
    },
    blues: {
        type: "genre",
        featureProfile: { instrumentalness: 0.4, acousticness: 0.65, valence: 0.35, energy: 0.45 },
        related: ["jazz", "soul", "rock"]
    },
    classical: {
        type: "genre",
        featureProfile: { instrumentalness: 0.95, acousticness: 0.9, speechiness: 0.05, danceability: 0.25 },
        related: ["orchestral", "piano", "instrumental"]
    },
    folk: {
        type: "genre",
        featureProfile: { instrumentalness: 0.3, acousticness: 0.85, energy: 0.35, danceability: 0.4 },
        related: ["acoustic", "country", "indie"]
    },
    country: {
        type: "genre",
        featureProfile: { instrumentalness: 0.25, acousticness: 0.6, valence: 0.6, danceability: 0.55 },
        related: ["folk", "americana"]
    },
    "r&b": {
        type: "genre",
        featureProfile: { instrumentalness: 0.2, acousticness: 0.3, danceability: 0.7, valence: 0.55 },
        related: ["soul", "hip-hop", "funk"]
    },
    soul: {
        type: "genre",
        featureProfile: { instrumentalness: 0.25, acousticness: 0.45, valence: 0.5, energy: 0.5 },
        related: ["r&b", "funk", "gospel"]
    },
    funk: {
        type: "genre",
        featureProfile: { instrumentalness: 0.35, acousticness: 0.3, danceability: 0.85, energy: 0.7 },
        related: ["soul", "disco", "groove"]
    },
    disco: {
        type: "genre",
        featureProfile: { instrumentalness: 0.3, acousticness: 0.2, danceability: 0.9, energy: 0.75, valence: 0.8 },
        related: ["funk", "house", "dance"]
    },
    pop: {
        type: "genre",
        featureProfile: { instrumentalness: 0.15, acousticness: 0.3, danceability: 0.7, valence: 0.65 },
        related: ["dance", "synth"]
    },
    indie: {
        type: "genre",
        featureProfile: { instrumentalness: 0.35, acousticness: 0.5, energy: 0.55, danceability: 0.5 },
        related: ["alternative", "rock", "folk"]
    },
    alternative: {
        type: "genre",
        featureProfile: { instrumentalness: 0.3, acousticness: 0.4, energy: 0.6, danceability: 0.5 },
        related: ["indie", "rock"]
    },
    reggae: {
        type: "genre",
        featureProfile: { instrumentalness: 0.3, acousticness: 0.4, danceability: 0.75, valence: 0.65, energy: 0.5 },
        related: ["dub", "ska"]
    },
    dubstep: {
        type: "genre",
        featureProfile: { instrumentalness: 0.6, acousticness: 0.05, energy: 0.85, danceability: 0.65 },
        related: ["electronic", "bass"]
    },
    dnb: {
        type: "genre",
        featureProfile: { instrumentalness: 0.7, acousticness: 0.05, energy: 0.9, danceability: 0.7 },
        related: ["electronic", "jungle", "bass"]
    },
    lofi: {
        type: "genre",
        featureProfile: { instrumentalness: 0.7, acousticness: 0.4, energy: 0.3, arousal: 0.3, danceability: 0.4 },
        related: ["chill", "hip-hop", "ambient"]
    },

    // === MOODS ===
    happy: {
        type: "mood",
        featureProfile: { valence: 0.85, energy: 0.7, arousal: 0.6, danceability: 0.7 },
        related: ["upbeat", "cheerful", "joyful"]
    },
    sad: {
        type: "mood",
        featureProfile: { valence: 0.2, energy: 0.3, arousal: 0.3, danceability: 0.3 },
        related: ["melancholic", "somber", "blue"]
    },
    melancholic: {
        type: "mood",
        featureProfile: { valence: 0.25, energy: 0.35, arousal: 0.4, acousticness: 0.5 },
        related: ["sad", "nostalgic", "bittersweet"]
    },
    angry: {
        type: "mood",
        featureProfile: { valence: 0.25, energy: 0.9, arousal: 0.9 },
        related: ["aggressive", "intense", "heavy"]
    },
    aggressive: {
        type: "mood",
        featureProfile: { valence: 0.3, energy: 0.9, arousal: 0.85 },
        related: ["angry", "intense", "heavy"]
    },
    peaceful: {
        type: "mood",
        featureProfile: { valence: 0.6, energy: 0.2, arousal: 0.2, acousticness: 0.6 },
        related: ["calm", "serene", "tranquil"]
    },
    calm: {
        type: "mood",
        featureProfile: { energy: 0.25, arousal: 0.25, valence: 0.55 },
        related: ["peaceful", "relaxed", "serene"]
    },
    anxious: {
        type: "mood",
        featureProfile: { valence: 0.3, arousal: 0.75, energy: 0.6 },
        related: ["tense", "nervous"]
    },
    romantic: {
        type: "mood",
        featureProfile: { valence: 0.6, energy: 0.4, acousticness: 0.5, arousal: 0.45 },
        related: ["love", "intimate", "sensual"]
    },
    hopeful: {
        type: "mood",
        featureProfile: { valence: 0.7, energy: 0.55, arousal: 0.5 },
        related: ["uplifting", "optimistic", "bright"]
    },
    nostalgic: {
        type: "mood",
        featureProfile: { valence: 0.45, energy: 0.4, arousal: 0.4 },
        related: ["melancholic", "bittersweet", "wistful"]
    },
    dark: {
        type: "mood",
        featureProfile: { valence: 0.2, energy: 0.5, acousticness: 0.3, arousal: 0.5 },
        related: ["brooding", "ominous", "moody"]
    },
    bright: {
        type: "mood",
        featureProfile: { valence: 0.8, energy: 0.65, arousal: 0.6 },
        related: ["happy", "cheerful", "sunny"]
    },

    // === VIBES ===
    chill: {
        type: "vibe",
        featureProfile: { energy: 0.3, arousal: 0.3, valence: 0.55, danceability: 0.45 },
        related: ["relaxed", "mellow", "laid-back"]
    },
    relaxed: {
        type: "vibe",
        featureProfile: { energy: 0.25, arousal: 0.25, valence: 0.5 },
        related: ["chill", "calm", "peaceful"]
    },
    energetic: {
        type: "vibe",
        featureProfile: { energy: 0.85, arousal: 0.8, danceability: 0.75 },
        related: ["upbeat", "powerful", "driving"]
    },
    upbeat: {
        type: "vibe",
        featureProfile: { energy: 0.75, valence: 0.75, danceability: 0.7 },
        related: ["energetic", "happy", "cheerful"]
    },
    groovy: {
        type: "vibe",
        featureProfile: { danceability: 0.85, energy: 0.65, valence: 0.6 },
        related: ["funky", "rhythmic", "danceable"]
    },
    dreamy: {
        type: "vibe",
        featureProfile: { energy: 0.35, arousal: 0.35, acousticness: 0.5, instrumentalness: 0.5 },
        related: ["ethereal", "atmospheric", "ambient"]
    },
    ethereal: {
        type: "vibe",
        featureProfile: { energy: 0.3, instrumentalness: 0.6, acousticness: 0.45, arousal: 0.35 },
        related: ["dreamy", "atmospheric", "ambient"]
    },
    atmospheric: {
        type: "vibe",
        featureProfile: { instrumentalness: 0.7, energy: 0.4, acousticness: 0.4 },
        related: ["ambient", "ethereal", "cinematic"]
    },
    intense: {
        type: "vibe",
        featureProfile: { energy: 0.85, arousal: 0.85, valence: 0.4 },
        related: ["powerful", "aggressive", "dramatic"]
    },
    playful: {
        type: "vibe",
        featureProfile: { valence: 0.75, energy: 0.65, danceability: 0.7 },
        related: ["fun", "quirky", "whimsical"]
    },
    brooding: {
        type: "vibe",
        featureProfile: { valence: 0.25, energy: 0.45, arousal: 0.5 },
        related: ["dark", "moody", "introspective"]
    },
    cinematic: {
        type: "vibe",
        featureProfile: { instrumentalness: 0.8, energy: 0.5, acousticness: 0.5 },
        related: ["epic", "dramatic", "orchestral"]
    },
    epic: {
        type: "vibe",
        featureProfile: { energy: 0.75, arousal: 0.7, instrumentalness: 0.6 },
        related: ["cinematic", "dramatic", "powerful"]
    },
    mellow: {
        type: "vibe",
        featureProfile: { energy: 0.3, arousal: 0.3, valence: 0.5, acousticness: 0.5 },
        related: ["chill", "relaxed", "soft"]
    },
    funky: {
        type: "vibe",
        featureProfile: { danceability: 0.85, energy: 0.7, valence: 0.65 },
        related: ["groovy", "rhythmic"]
    },
    hypnotic: {
        type: "vibe",
        featureProfile: { instrumentalness: 0.7, danceability: 0.6, energy: 0.5, arousal: 0.5 },
        related: ["trance", "repetitive", "mesmerizing"]
    },

    // === DESCRIPTORS ===
    fast: {
        type: "descriptor",
        featureProfile: { energy: 0.8, danceability: 0.7 },
        related: ["energetic", "upbeat"]
    },
    slow: {
        type: "descriptor",
        featureProfile: { energy: 0.3, danceability: 0.35 },
        related: ["chill", "relaxed"]
    },
    heavy: {
        type: "descriptor",
        featureProfile: { energy: 0.85, acousticness: 0.15 },
        related: ["intense", "aggressive", "metal"]
    },
    soft: {
        type: "descriptor",
        featureProfile: { energy: 0.25, acousticness: 0.6 },
        related: ["gentle", "quiet", "mellow"]
    },
    loud: {
        type: "descriptor",
        featureProfile: { energy: 0.85 },
        related: ["intense", "powerful"]
    },
    acoustic: {
        type: "descriptor",
        featureProfile: { acousticness: 0.9, instrumentalness: 0.4 },
        related: ["unplugged", "folk"]
    },
    vocal: {
        type: "descriptor",
        featureProfile: { instrumentalness: 0.1, speechiness: 0.2 },
        related: ["singing", "lyrics"]
    },
    instrumental: {
        type: "descriptor",
        featureProfile: { instrumentalness: 0.9, speechiness: 0.05 },
        related: ["no vocals"]
    },
    danceable: {
        type: "descriptor",
        featureProfile: { danceability: 0.85, energy: 0.7 },
        related: ["groovy", "rhythmic"]
    },
    synth: {
        type: "descriptor",
        featureProfile: { acousticness: 0.1, instrumentalness: 0.5 },
        related: ["electronic", "synthesizer"]
    },
    bass: {
        type: "descriptor",
        featureProfile: { energy: 0.7, acousticness: 0.1 },
        related: ["heavy", "dubstep", "dnb"]
    },
    guitar: {
        type: "descriptor",
        featureProfile: { acousticness: 0.5 },
        related: ["rock", "folk", "blues"]
    },
    piano: {
        type: "descriptor",
        featureProfile: { acousticness: 0.7, instrumentalness: 0.6 },
        related: ["classical", "jazz"]
    },
    orchestral: {
        type: "descriptor",
        featureProfile: { instrumentalness: 0.95, acousticness: 0.85 },
        related: ["classical", "cinematic", "epic"]
    },
};

// Helper to get all term names
export const VOCABULARY_TERMS = Object.keys(VOCAB_DEFINITIONS);
