import Link from "next/link";
import { Smartphone, QrCode, ArrowRight } from "lucide-react";

export function LinkDeviceSection() {
    return (
        <div
            id="link-device"
            className="bg-[#111] rounded-lg p-6 border border-[#1c1c1c]"
        >
            <div className="flex items-center gap-3 mb-4">
                <div className="p-2 rounded-lg bg-[#2323FF]/10">
                    <Smartphone className="w-5 h-5 text-[#5b5bff]" />
                </div>
                <div>
                    <h3 className="font-medium text-white">Link Device</h3>
                    <p className="text-sm text-gray-400">
                        Connect your phone without typing passwords
                    </p>
                </div>
            </div>

            <p className="text-sm text-gray-400 mb-4">
                Generate a QR code or 6-digit code to quickly link a compatible device.
                For general mobile playback, use the soundspan PWA or a Subsonic-compatible client.
            </p>

            <Link
                href="/device"
                className="inline-flex items-center gap-2 px-4 py-2 bg-[#2323FF]/20 hover:bg-[#2323FF]/30 text-[#5b5bff] rounded-lg transition-colors border border-[#2323FF]/30"
            >
                <QrCode className="w-4 h-4" />
                <span>Link a Device</span>
                <ArrowRight className="w-4 h-4" />
            </Link>
        </div>
    );
}














