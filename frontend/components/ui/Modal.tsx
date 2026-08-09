"use client";

import { ReactNode, useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/utils/cn";
import { Button } from "./Button";
import { nextFocusIndex } from "./focusTrapMath";

const FOCUSABLE_SELECTOR =
    "a:not([tabindex='-1']), button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])";

export interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: ReactNode;
    footer?: ReactNode;
    className?: string;
}

function useEscapeAndScrollLock(isOpen: boolean, onClose: () => void) {
    useEffect(() => {
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") onClose();
        };

        if (isOpen) {
            document.addEventListener("keydown", handleEscape);
            document.body.style.overflow = "hidden";
        }

        return () => {
            document.removeEventListener("keydown", handleEscape);
            document.body.style.overflow = "unset";
        };
    }, [isOpen, onClose]);
}

function useDialogFocus(
    isOpen: boolean,
    dialogRef: React.RefObject<HTMLDivElement | null>,
    previouslyFocusedRef: React.RefObject<HTMLElement | null>,
) {
    useEffect(() => {
        if (!isOpen) return;
        const dialog = dialogRef.current;
        if (!dialog) return;

        previouslyFocusedRef.current =
            document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
        const handleTab = (event: KeyboardEvent) => {
            if (event.key !== "Tab") return;
            const elements = Array.from(
                dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
            );
            const currentIndex = elements.indexOf(
                document.activeElement as HTMLElement,
            );
            const nextIndex = nextFocusIndex(
                elements.length,
                currentIndex,
                event.shiftKey,
            );
            event.preventDefault();
            if (nextIndex === -1) {
                dialog.focus();
                return;
            }
            elements[nextIndex]?.focus();
        };

        dialog.addEventListener("keydown", handleTab);
        dialog.focus();
        return () => {
            dialog.removeEventListener("keydown", handleTab);
            const previouslyFocused = previouslyFocusedRef.current;
            previouslyFocusedRef.current = null;
            if (previouslyFocused?.isConnected) previouslyFocused.focus();
        };
    }, [dialogRef, isOpen, previouslyFocusedRef]);
}

/**
 * Renders the Modal component.
 */
export function Modal({
    isOpen,
    onClose,
    title,
    children,
    footer,
    className,
}: ModalProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const previouslyFocusedRef = useRef<HTMLElement | null>(null);
    const titleId = useId();
    useEscapeAndScrollLock(isOpen, onClose);
    useDialogFocus(isOpen, dialogRef, previouslyFocusedRef);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[10010] flex items-center justify-center p-4 bg-black/60 ">
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className={cn(
                    "bg-gradient-to-br from-surface-overlay to-surface-raised border border-line rounded-sm shadow-2xl max-w-md w-full p-6",
                    className
                )}
            >
                {/* Header */}
                <div className="flex items-center justify-between mb-4 pb-4 border-b border-surface-active">
                    <h2 id={titleId} className="text-lg font-medium text-white">
                        {title}
                    </h2>
                    <Button
                        variant="icon"
                        onClick={onClose}
                        aria-label="Close"
                        className="hover:text-gray-300"
                    >
                        <X className="w-5 h-5" />
                    </Button>
                </div>

                {/* Content */}
                <div className="mb-6">{children}</div>

                {/* Footer */}
                {footer && (
                    <div className="flex gap-3 justify-end">{footer}</div>
                )}
            </div>
        </div>
    );
}
