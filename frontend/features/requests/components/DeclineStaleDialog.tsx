"use client";

import { useId, useState } from "react";
import { ControlSelect } from "@/components/ui/ControlSelect";
import { Modal } from "@/components/ui/Modal";
import {
    DEFAULT_STALE_REQUEST_AGE_DAYS,
    STALE_REQUEST_AGE_OPTIONS,
} from "../requestViewModel";
import { DeclineReasonField } from "./DeclineReasonField";

interface DeclineStaleDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: (olderThanDays: number, reason: string) => void;
}

/** Confirms declining every pending request older than a chosen age. */
export function DeclineStaleDialog(props: DeclineStaleDialogProps) {
    const selectId = useId();
    const [days, setDays] = useState<number>(DEFAULT_STALE_REQUEST_AGE_DAYS);
    const [reason, setReason] = useState("");
    const confirm = () => {
        props.onConfirm(days, reason.trim());
        props.onClose();
    };
    return (
        <Modal
            isOpen={props.isOpen}
            onClose={props.onClose}
            title="Decline stale requests"
            footer={
                <>
                    <button
                        type="button"
                        onClick={props.onClose}
                        className="rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-white/10"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={confirm}
                        className="rounded-lg bg-red-500 px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-red-600"
                    >
                        Decline stale requests
                    </button>
                </>
            }
        >
            <div className="space-y-4 text-sm text-gray-300">
                <div className="space-y-2">
                    <label
                        htmlFor={selectId}
                        className="block text-sm font-medium text-white"
                    >
                        Decline pending requests older than
                    </label>
                    <ControlSelect
                        id={selectId}
                        value={days}
                        onChange={(event) =>
                            setDays(Number(event.target.value))
                        }
                    >
                        {STALE_REQUEST_AGE_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                                {option} days
                            </option>
                        ))}
                    </ControlSelect>
                </div>
                <p>
                    Each requester is notified. Declining stale requests does
                    not start a re-request cooldown, so users can ask again.
                </p>
                <DeclineReasonField value={reason} onChange={setReason} />
            </div>
        </Modal>
    );
}
