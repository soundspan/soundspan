"use client";

import { useId } from "react";
import { MAX_DECLINE_REASON_LENGTH } from "../requestViewModel";

interface DeclineReasonFieldProps {
    value: string;
    onChange: (value: string) => void;
}

/** Optional decline reason, shown to the requester in their notification. */
export function DeclineReasonField({
    value,
    onChange,
}: DeclineReasonFieldProps) {
    const id = useId();
    return (
        <div className="space-y-2">
            <label
                htmlFor={id}
                className="block text-sm font-medium text-white"
            >
                Reason (optional)
            </label>
            <textarea
                id={id}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                maxLength={MAX_DECLINE_REASON_LENGTH}
                rows={3}
                placeholder="The requester sees this in their notification."
                className="w-full resize-none rounded border border-white/10 bg-surface-elevated px-4 py-2 text-sm text-white placeholder:text-gray-500 focus:border-white/30 focus:outline-none"
            />
        </div>
    );
}
