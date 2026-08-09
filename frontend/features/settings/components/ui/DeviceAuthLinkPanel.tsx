"use client";

import type { ReactNode } from "react";
import { CheckCircle, Copy, ExternalLink, Loader2, type LucideIcon } from "lucide-react";
import { formatTime } from "@/utils/formatTime";

/** Content and controls displayed by the shared device-code linking panel. */
export interface DeviceAuthLinkPanelProps {
    userCode: string;
    verificationUrl: string;
    timeLeftSeconds: number | null;
    copied: boolean;
    onCopyCode: () => void;
    onCancel: () => void;
    introText: string;
    pasteInstruction: string;
    signInInstruction: ReactNode;
    openLinkLabel: string;
}

interface NumberedStepProps {
    number: number;
    children: ReactNode;
}

function PanelIcon({
    icon: Icon,
    className,
}: {
    icon: LucideIcon;
    className: string;
}) {
    if (!Icon) return null;
    return <Icon className={className} />;
}

function NumberedStep({ number, children }: NumberedStepProps) {
    return (
        <div className="flex items-start gap-3">
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-600 text-white text-xs flex items-center justify-center font-bold mt-0.5">
                {number}
            </span>
            {children}
        </div>
    );
}

function CodeStep({ userCode, copied, onCopyCode, pasteInstruction }: Pick<
    DeviceAuthLinkPanelProps,
    "userCode" | "copied" | "onCopyCode" | "pasteInstruction"
>) {
    return (
        <NumberedStep number={1}>
            <div className="space-y-2">
                <p className="text-sm text-gray-300">
                    {pasteInstruction}
                    <span className="text-gray-500 text-xs ml-1">
                        (it&apos;s already on your clipboard)
                    </span>
                </p>
                <div className="flex items-center gap-3">
                    <code className="px-4 py-2 text-lg font-mono font-bold tracking-wider bg-[#1a1a1a] text-white rounded-lg border border-[#444] select-all">
                        {userCode}
                    </code>
                    <button onClick={onCopyCode} className="p-2 text-gray-400 hover:text-white transition-colors" title="Copy code">
                        {copied
                            ? <PanelIcon icon={CheckCircle} className="w-4 h-4 text-green-400" />
                            : <PanelIcon icon={Copy} className="w-4 h-4" />}
                    </button>
                </div>
            </div>
        </NumberedStep>
    );
}

function WaitingRow({ timeLeftSeconds }: Pick<DeviceAuthLinkPanelProps, "timeLeftSeconds">) {
    return (
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-400">
                <PanelIcon icon={Loader2} className="w-3 h-3 animate-spin" />
                <span>Waiting for you to complete sign-in...</span>
            </div>
            {timeLeftSeconds !== null && (
                <span className={`text-xs tabular-nums ${
                    timeLeftSeconds < 120 ? "text-amber-400/70" : "text-gray-500"
                }`}>
                    Expires in {formatTime(timeLeftSeconds)}
                </span>
            )}
        </div>
    );
}

/** Renders reusable instructions and controls for a device-code authentication session. */
export function DeviceAuthLinkPanel(props: DeviceAuthLinkPanelProps) {
    return (
        <div className="p-4 bg-[#252525] rounded-lg border border-[#333] space-y-4">
            <div className="space-y-3">
                <p className="text-sm text-gray-300">{props.introText}</p>
                <CodeStep {...props} />
                <NumberedStep number={2}>
                    <p className="text-sm text-gray-300">{props.signInInstruction}</p>
                </NumberedStep>
                <NumberedStep number={3}>
                    <p className="text-sm text-gray-300">
                        Return here — this page will update automatically
                    </p>
                </NumberedStep>
            </div>
            {props.verificationUrl && (
                <a
                    href={props.verificationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-blue-600/20 text-blue-400 rounded-full
                        hover:bg-blue-600/30 border border-blue-500/30 transition-colors"
                >
                    <PanelIcon icon={ExternalLink} className="w-4 h-4" />
                    {props.openLinkLabel}
                </a>
            )}
            <WaitingRow timeLeftSeconds={props.timeLeftSeconds} />
            <button onClick={props.onCancel} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
                Cancel
            </button>
        </div>
    );
}
