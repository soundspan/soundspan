"use client";

import { useState } from "react";
import { Edit, X, Save } from "lucide-react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { GradientSpinner } from "./ui/GradientSpinner";
import { MusicBrainzLookup } from "./ui/MusicBrainzLookup";
import Image from "next/image";

interface MetadataEditorProps {
    type: "artist" | "album" | "track";
    id: string;
    currentData: {
        name?: string;
        title?: string;
        bio?: string;
        genres?: string[];
        year?: number;
        mbid?: string;
        rgMbid?: string;
        coverUrl?: string;
        heroUrl?: string;
        // Original values for comparison (when user overrides exist)
        _originalName?: string;
        _originalBio?: string | null;
        _originalGenres?: string[];
        _originalHeroUrl?: string | null;
        _originalTitle?: string;
        _originalYear?: number | null;
        _originalCoverUrl?: string | null;
        _hasUserOverrides?: boolean;
    };
    artistName?: string;
    onSave?: (updatedData: Record<string, unknown> | null) => void;
}

type MetadataFormField =
    | "name"
    | "title"
    | "bio"
    | "genres"
    | "year"
    | "mbid"
    | "rgMbid"
    | "coverUrl"
    | "heroUrl";

interface MetadataEditorApiErrorData {
    error?: string;
    message?: string;
    code?: string;
    field?: string;
    hint?: string;
    expectedFormat?: string;
}

interface MetadataEditorApiError extends Error {
    status?: number;
    data?: MetadataEditorApiErrorData;
}

function toMetadataEditorApiError(error: unknown): MetadataEditorApiError | null {
    if (!error || typeof error !== "object") {
        return null;
    }
    const candidate = error as MetadataEditorApiError;
    return candidate.data || typeof candidate.status === "number"
        ? candidate
        : null;
}

/**
 * Metadata Editor Component
 * Plex/Kavita-style metadata editor with pencil icon
 * Opens a modal for editing artist/album/track metadata
 */
export function MetadataEditor({
    type,
    id,
    currentData,
    artistName,
    onSave,
}: MetadataEditorProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isResetting, setIsResetting] = useState(false);
    const [formData, setFormData] = useState(currentData);
    const [formError, setFormError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<
        Partial<Record<MetadataFormField, string>>
    >({});
    const hasOverrides = currentData._hasUserOverrides ?? false;
    const mbidField = type === "album" ? "rgMbid" : "mbid";
    const mbidFieldError = fieldErrors[mbidField];

    const handleOpen = () => {
        setFormData(currentData);
        setFormError(null);
        setFieldErrors({});
        setIsOpen(true);
    };

    const handleClose = () => {
        setIsOpen(false);
        setFormData(currentData);
        setFormError(null);
        setFieldErrors({});
    };

    const handleReset = async () => {
        if (
            !confirm(
                "Reset all metadata to original values? This cannot be undone."
            )
        ) {
            return;
        }

        setIsResetting(true);
        try {
            if (type === "artist") {
                await api.resetArtistMetadata(id);
            } else if (type === "album") {
                await api.resetAlbumMetadata(id);
            } else {
                await api.resetTrackMetadata(id);
            }

            toast.success("Metadata reset to original values");
            onSave?.(null);
            setIsOpen(false);
        } catch (error: unknown) {
            toast.error(error instanceof Error ? error.message : "Failed to reset metadata");
        } finally {
            setIsResetting(false);
        }
    };

    const handleSave = async () => {
        setFormError(null);
        setFieldErrors({});
        setIsSaving(true);
        try {
            // Call API to update metadata
            let response;
            if (type === "artist") {
                response = await api.updateArtistMetadata(id, formData);
            } else if (type === "album") {
                response = await api.updateAlbumMetadata(id, formData);
            } else {
                response = await api.updateTrackMetadata(id, formData);
            }

            toast.success(
                `${
                    type === "artist"
                        ? "Artist"
                        : type === "album"
                        ? "Album"
                        : "Track"
                } metadata updated`
            );
            onSave?.(response);
            setIsOpen(false);
        } catch (error: unknown) {
            console.error("Failed to update metadata:", error);
            const apiError = toMetadataEditorApiError(error);
            if (apiError?.data) {
                const apiField =
                    typeof apiError.data.field === "string"
                        ? apiError.data.field
                        : null;
                const message = (
                    typeof apiError.data.error === "string" &&
                    apiError.data.error
                )
                    ? apiError.data.error
                    : apiError instanceof Error && apiError.message
                    ? apiError.message
                    : "Failed to update metadata";
                const hint =
                    typeof apiError.data.hint === "string"
                        ? apiError.data.hint
                        : null;
                const expectedFormat =
                    typeof apiError.data.expectedFormat === "string"
                        ? apiError.data.expectedFormat
                        : null;
                const fieldMessage =
                    expectedFormat && message.includes("format")
                        ? `${message}. Expected: ${expectedFormat}`
                        : message;

                if (
                    apiField === "mbid" ||
                    apiField === "rgMbid" ||
                    apiField === "name" ||
                    apiField === "title" ||
                    apiField === "bio" ||
                    apiField === "genres" ||
                    apiField === "year" ||
                    apiField === "coverUrl" ||
                    apiField === "heroUrl"
                ) {
                    setFieldErrors((prev) => ({
                        ...prev,
                        [apiField]: fieldMessage,
                    }));
                }

                if (apiError.status === 409 && hint) {
                    setFormError(`${message}. ${hint}`);
                    toast.error(`${message}. ${hint}`);
                } else {
                    setFormError(message);
                    toast.error(message);
                }
            } else {
                const fallbackMessage =
                    error instanceof Error
                        ? error.message
                        : "Failed to update metadata";
                setFormError(fallbackMessage);
                toast.error(fallbackMessage);
            }
        } finally {
            setIsSaving(false);
        }
    };

    const handleChange = (field: string, value: string | number | string[] | null) => {
        if (formError) {
            setFormError(null);
        }
        if (
            field === "mbid" ||
            field === "rgMbid" ||
            field === "name" ||
            field === "title" ||
            field === "bio" ||
            field === "genres" ||
            field === "year" ||
            field === "coverUrl" ||
            field === "heroUrl"
        ) {
            setFieldErrors((prev) => {
                if (!prev[field]) {
                    return prev;
                }
                const next = { ...prev };
                delete next[field];
                return next;
            });
        }
        setFormData((prev) => ({ ...prev, [field]: value }));
    };

    return (
        <>
            {/* Pencil Icon Button */}
            <button
                onClick={handleOpen}
                className="p-2 rounded-full bg-black/40 hover:bg-black/60 transition-all opacity-0 group-hover:opacity-100"
                title={`Edit ${type} metadata`}
            >
                <Edit className="w-4 h-4 text-white" />
            </button>

            {/* Modal */}
            {isOpen && (
                <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
                    <div className="bg-[#121212] rounded-lg max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
                        {/* Header */}
                        <div className="flex items-center justify-between p-6 border-b border-white/10">
                            <h2 className="text-2xl font-bold text-white">
                                Edit{" "}
                                {type === "artist"
                                    ? "Artist"
                                    : type === "album"
                                    ? "Album"
                                    : "Track"}{" "}
                                Metadata
                            </h2>
                            <button
                                onClick={handleClose}
                                className="p-2 hover:bg-white/10 rounded-full transition-all"
                            >
                                <X className="w-6 h-6 text-white" />
                            </button>
                        </div>

                        {/* Content */}
                        <div className="flex-1 overflow-y-auto p-6 space-y-4">
                            {formError && (
                                <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300">
                                    {formError}
                                </div>
                            )}

                            {/* Name/Title */}
                            <div>
                                <label className="block text-sm font-bold text-white mb-2">
                                    {type === "artist"
                                        ? "Artist Name"
                                        : type === "album"
                                        ? "Album Title"
                                        : "Track Title"}
                                </label>
                                <input
                                    type="text"
                                    value={
                                        formData.name || formData.title || ""
                                    }
                                    onChange={(e) =>
                                        handleChange(
                                            type === "artist"
                                                ? "name"
                                                : "title",
                                            e.target.value
                                        )
                                    }
                                    className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none"
                                />
                                {type === "artist" &&
                                    currentData._originalName &&
                                    currentData._originalName !==
                                        (formData.name || "") && (
                                        <p className="mt-1 text-xs text-gray-500">
                                            Original:{" "}
                                            {currentData._originalName}
                                        </p>
                                    )}
                                {type !== "artist" &&
                                    currentData._originalTitle &&
                                    currentData._originalTitle !==
                                        (formData.title || "") && (
                                        <p className="mt-1 text-xs text-gray-500">
                                            Original:{" "}
                                            {currentData._originalTitle}
                                        </p>
                                    )}
                            </div>

                            {/* Bio (Artist only) */}
                            {type === "artist" && (
                                <div>
                                    <label className="block text-sm font-bold text-white mb-2">
                                        Biography
                                    </label>
                                    <textarea
                                        value={formData.bio || ""}
                                        onChange={(e) =>
                                            handleChange("bio", e.target.value)
                                        }
                                        rows={6}
                                        className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none resize-none"
                                    />
                                    {currentData._originalBio &&
                                        currentData._originalBio !==
                                            (formData.bio || "") && (
                                            <p className="mt-1 text-xs text-gray-500">
                                                Original:{" "}
                                                {currentData._originalBio.substring(
                                                    0,
                                                    100
                                                )}
                                                ...
                                            </p>
                                        )}
                                </div>
                            )}

                            {/* Year (Album only) */}
                            {type === "album" && (
                                <div>
                                    <label className="block text-sm font-bold text-white mb-2">
                                        Release Year
                                    </label>
                                    <input
                                        type="number"
                                        value={formData.year || ""}
                                        onChange={(e) =>
                                            handleChange(
                                                "year",
                                                parseInt(e.target.value)
                                            )
                                        }
                                        className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none"
                                    />
                                    {currentData._originalYear &&
                                        currentData._originalYear !==
                                            (formData.year || null) && (
                                            <p className="mt-1 text-xs text-gray-500">
                                                Original:{" "}
                                                {currentData._originalYear}
                                            </p>
                                        )}
                                </div>
                            )}

                            {/* Genres */}
                            <div>
                                <label className="block text-sm font-bold text-white mb-2">
                                    Genres
                                    <span className="text-xs text-gray-400 ml-2">
                                        (comma-separated)
                                    </span>
                                </label>
                                <input
                                    type="text"
                                    value={formData.genres?.join(", ") || ""}
                                    onChange={(e) =>
                                        handleChange(
                                            "genres",
                                            e.target.value
                                                .split(",")
                                                .map((g) => g.trim())
                                                .filter(Boolean)
                                        )
                                    }
                                    placeholder="Rock, Alternative, Indie"
                                    className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none"
                                />
                                {currentData._originalGenres &&
                                    currentData._originalGenres.length > 0 &&
                                    JSON.stringify(
                                        currentData._originalGenres.sort()
                                    ) !==
                                        JSON.stringify(
                                            (formData.genres || []).sort()
                                        ) && (
                                        <p className="mt-1 text-xs text-gray-500">
                                            Original:{" "}
                                            {currentData._originalGenres.join(
                                                ", "
                                            )}
                                        </p>
                                    )}
                            </div>

                            {/* MusicBrainz ID */}
                            <div>
                                <label className="block text-sm font-bold text-white mb-2">
                                    {type === "album"
                                        ? "Release Group MBID"
                                        : "MusicBrainz ID"}
                                    <span className="text-xs text-gray-400 ml-2">
                                        (leave empty to auto-fetch)
                                    </span>
                                </label>
                                {type === "track" ? (
                                    <input
                                        type="text"
                                        value={formData.mbid || ""}
                                        onChange={(e) =>
                                            handleChange("mbid", e.target.value)
                                        }
                                        placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                                        className={`w-full px-4 py-2 bg-[#181818] border rounded text-white focus:outline-none font-mono text-sm ${
                                            mbidFieldError
                                                ? "border-red-500/60 focus:border-red-500"
                                                : "border-white/10 focus:border-white/30"
                                        }`}
                                    />
                                ) : (
                                    <div
                                        className={
                                            mbidFieldError
                                                ? "rounded border border-red-500/40 bg-red-500/5 p-3"
                                                : undefined
                                        }
                                    >
                                        <MusicBrainzLookup
                                            type={type === "album" ? "album" : "artist"}
                                            currentValue={
                                                type === "artist"
                                                    ? formData.mbid || ""
                                                    : formData.rgMbid || ""
                                            }
                                            currentName={formData.name || formData.title}
                                            artistName={artistName}
                                            onSelect={(mbid) =>
                                                handleChange(
                                                    type === "artist" ? "mbid" : "rgMbid",
                                                    mbid
                                                )
                                            }
                                        />
                                    </div>
                                )}
                                {mbidFieldError && (
                                    <p className="mt-2 text-xs text-red-300">
                                        {mbidFieldError}
                                    </p>
                                )}
                            </div>

                            {/* Image URL */}
                            <div>
                                <label className="block text-sm font-bold text-white mb-2">
                                    {type === "artist"
                                        ? "Artist Image URL"
                                        : "Cover Art URL"}
                                    <span className="text-xs text-gray-400 ml-2">
                                        (leave empty to auto-fetch)
                                    </span>
                                </label>
                                <input
                                    type="url"
                                    value={
                                        type === "artist"
                                            ? formData.heroUrl || ""
                                            : formData.coverUrl || ""
                                    }
                                    onChange={(e) =>
                                        handleChange(
                                            type === "artist"
                                                ? "heroUrl"
                                                : "coverUrl",
                                            e.target.value
                                        )
                                    }
                                    placeholder="https://..."
                                    className="w-full px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none text-sm"
                                />
                                {type === "artist" &&
                                    currentData._originalHeroUrl &&
                                    currentData._originalHeroUrl !==
                                        (formData.heroUrl || "") && (
                                        <p className="mt-1 text-xs text-gray-500 truncate">
                                            Original:{" "}
                                            {currentData._originalHeroUrl}
                                        </p>
                                    )}
                                {type === "album" &&
                                    currentData._originalCoverUrl &&
                                    currentData._originalCoverUrl !==
                                        (formData.coverUrl || "") && (
                                        <p className="mt-1 text-xs text-gray-500 truncate">
                                            Original:{" "}
                                            {currentData._originalCoverUrl}
                                        </p>
                                    )}
                                {/* Image Preview */}
                                {(formData.heroUrl || formData.coverUrl) && (
                                    <div className="mt-2">
                                        <Image
                                            src={
                                                formData.heroUrl ||
                                                formData.coverUrl
                                            }
                                            alt="Preview"
                                            width={128}
                                            height={128}
                                            className="w-32 h-32 object-cover rounded"
                                            unoptimized
                                        />
                                    </div>
                                )}
                            </div>

                            {/* Manual Override Warning */}
                            <div className="bg-yellow-600/10 border border-yellow-600/20 rounded p-4">
                                <p className="text-sm text-yellow-400">
                                    <strong>Note:</strong> Manually edited
                                    metadata will not be overwritten by
                                    automatic enrichment.
                                </p>
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="flex items-center justify-end gap-3 p-6 border-t border-white/10">
                            {hasOverrides && (
                                <button
                                    onClick={handleReset}
                                    disabled={isSaving || isResetting}
                                    className="px-6 py-2 rounded-full bg-red-500/20 hover:bg-red-500/30 text-red-400 font-bold transition-all border border-red-500/30 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isResetting
                                        ? "Resetting..."
                                        : "Reset to Original"}
                                </button>
                            )}
                            <button
                                onClick={handleClose}
                                className="px-6 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white font-bold transition-all"
                                disabled={isSaving}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={isSaving}
                                className="px-6 py-2 rounded-full bg-[#60a5fa] hover:bg-[#3b82f6] text-black font-bold transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isSaving ? (
                                    <>
                                        <GradientSpinner size="sm" />
                                        Saving...
                                    </>
                                ) : (
                                    <>
                                        <Save className="w-4 h-4" />
                                        Save Changes
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
