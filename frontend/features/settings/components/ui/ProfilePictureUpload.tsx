"use client";

import { useRef, useState, useEffect } from "react";
import { Upload, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

interface ProfilePictureUploadProps {
    hasProfilePicture?: boolean;
    onChanged?: () => void;
}

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_FILE_SIZE_MB = 5;

export function ProfilePictureUpload({
    hasProfilePicture: initialHasPicture,
    onChanged,
}: ProfilePictureUploadProps) {
    const { user } = useAuth();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [isRemoving, setIsRemoving] = useState(false);
    const [hasPicture, setHasPicture] = useState(initialHasPicture ?? false);
    const [previewKey, setPreviewKey] = useState(0);

    useEffect(() => {
        if (initialHasPicture !== undefined) {
            setHasPicture(initialHasPicture);
        }
    }, [initialHasPicture]);

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        // Reset input so the same file can be re-selected
        e.target.value = "";

        if (!ACCEPTED_TYPES.includes(file.type)) {
            toast.error("Invalid file type. Use JPEG, PNG, WebP, or GIF.");
            return;
        }

        if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
            toast.error(`File too large. Maximum ${MAX_FILE_SIZE_MB}MB.`);
            return;
        }

        try {
            setIsUploading(true);
            await api.uploadProfilePicture(file);
            setHasPicture(true);
            setPreviewKey((k) => k + 1);
            toast.success("Profile picture updated");
            window.dispatchEvent(new Event("profile-picture-changed"));
            onChanged?.();
        } catch (err) {
            toast.error(
                err instanceof Error ? err.message : "Failed to upload"
            );
        } finally {
            setIsUploading(false);
        }
    };

    const handleRemove = async () => {
        try {
            setIsRemoving(true);
            await api.deleteProfilePicture();
            setHasPicture(false);
            toast.success("Profile picture removed");
            window.dispatchEvent(new Event("profile-picture-changed"));
            onChanged?.();
        } catch {
            toast.error("Failed to remove profile picture");
        } finally {
            setIsRemoving(false);
        }
    };

    const displayName = user?.displayName || user?.username || "?";
    const initial = displayName.charAt(0).toUpperCase();
    const isBusy = isUploading || isRemoving;

    return (
        <div className="flex items-center gap-3">
            {/* Avatar preview */}
            <div className="relative w-12 h-12 rounded-full overflow-hidden bg-white/10 text-white/80 text-lg font-semibold flex items-center justify-center shrink-0">
                {hasPicture && user ? (
                    <img
                        key={previewKey}
                        src={`${api.getProfilePictureUrl(user.id)}&_k=${previewKey}`}
                        alt="Profile"
                        className="w-full h-full object-cover"
                    />
                ) : (
                    initial
                )}
                {isBusy && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                        <Loader2 className="w-5 h-5 animate-spin text-white" />
                    </div>
                )}
            </div>

            {/* Actions */}
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileSelect}
            />
            <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-white/10 hover:bg-white/15 text-white transition-colors disabled:opacity-50"
            >
                <Upload className="w-3.5 h-3.5" />
                Upload
            </button>
            {hasPicture && (
                <button
                    type="button"
                    onClick={handleRemove}
                    disabled={isBusy}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-white/10 hover:bg-red-500/20 text-white/60 hover:text-red-400 transition-colors disabled:opacity-50"
                >
                    <Trash2 className="w-3.5 h-3.5" />
                    Remove
                </button>
            )}
        </div>
    );
}
