"use client";

import { AlertTriangle } from "lucide-react";
import { Modal } from "./Modal";

interface ConfirmDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    variant?: "danger" | "warning" | "info";
}

const variantStyles = {
    danger: {
        icon: "text-red-500",
        iconBg: "bg-red-500/10",
        confirmButton: "bg-red-500 hover:bg-red-600 text-white",
    },
    warning: {
        icon: "text-yellow-500",
        iconBg: "bg-yellow-500/10",
        confirmButton: "bg-yellow-500 hover:bg-yellow-600 text-black",
    },
    info: {
        icon: "text-blue-500",
        iconBg: "bg-blue-500/10",
        confirmButton: "bg-blue-500 hover:bg-blue-600 text-white",
    },
};

/**
 * Renders the ConfirmDialog component.
 */
export function ConfirmDialog({
    isOpen,
    onClose,
    onConfirm,
    title,
    message,
    confirmText = "Confirm",
    cancelText = "Cancel",
    variant = "danger",
}: ConfirmDialogProps) {
    const styles = variantStyles[variant];

    const handleConfirm = () => {
        onConfirm();
        onClose();
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={title}
            footer={
                <>
                    <button
                        onClick={onClose}
                        className="flex-1 px-4 py-3 bg-white/5 hover:bg-white/10 text-white font-semibold rounded-lg transition-all border border-white/10"
                    >
                        {cancelText}
                    </button>
                    <button
                        onClick={handleConfirm}
                        className={`flex-1 px-4 py-3 font-semibold rounded-lg transition-all ${styles.confirmButton}`}
                    >
                        {confirmText}
                    </button>
                </>
            }
        >
            <div className="flex items-start gap-4">
                <div
                    className={`w-12 h-12 rounded-full ${styles.iconBg} flex items-center justify-center flex-shrink-0`}
                >
                    <AlertTriangle className={`w-6 h-6 ${styles.icon}`} />
                </div>
                <p className="flex-1 min-w-0 text-sm text-gray-400">{message}</p>
            </div>
        </Modal>
    );
}
