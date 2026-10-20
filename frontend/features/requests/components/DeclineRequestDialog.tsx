"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import type { MusicRequest } from "@/lib/api/requests";
import { declineCooldownNotice } from "../requestViewModel";
import { DeclineReasonField } from "./DeclineReasonField";

interface DeclineRequestDialogProps {
    request: MusicRequest | null;
    /** Server cooldown setting in days; null while unknown. */
    deniedCooldownDays: number | null;
    onClose: () => void;
    onConfirm: (request: MusicRequest, reason: string) => void;
}

/**
 * Confirms declining one request with an optional reason. Mount it with a
 * `key` per request so the reason resets between requests.
 */
export function DeclineRequestDialog(props: DeclineRequestDialogProps) {
    const [reason, setReason] = useState("");
    const { request } = props;
    const confirm = () => {
        if (!request) return;
        props.onConfirm(request, reason.trim());
        props.onClose();
    };
    return (
        <Modal
            isOpen={Boolean(request)}
            onClose={props.onClose}
            title="Decline request"
            footer={
                <>
                    <button
                        type="button"
                        onClick={props.onClose}
                        className="rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-white/10"
                    >
                        Keep it
                    </button>
                    <button
                        type="button"
                        onClick={confirm}
                        className="rounded-lg bg-red-500 px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-red-600"
                    >
                        Decline
                    </button>
                </>
            }
        >
            <div className="space-y-4 text-sm text-gray-300">
                <p>
                    Decline{" "}
                    <span className="font-medium text-white">
                        {request?.artistName} — {request?.albumTitle}
                    </span>
                    ? {declineCooldownNotice(props.deniedCooldownDays)}
                </p>
                <DeclineReasonField value={reason} onChange={setReason} />
            </div>
        </Modal>
    );
}
