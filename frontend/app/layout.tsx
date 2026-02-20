import type { Metadata, Viewport } from "next";
import { Montserrat } from "next/font/google";
import localFont from "next/font/local";
import Script from "next/script";
import "./globals.css";
import { AuthProvider } from "@/lib/auth-context";
import { FeaturesProvider } from "@/lib/features-context";
import { ToastProvider } from "@/lib/toast-context";
import { DownloadProvider } from "@/lib/download-context";
import { ConditionalAudioProvider } from "@/components/providers/ConditionalAudioProvider";
import { AuthenticatedLayout } from "@/components/layout/AuthenticatedLayout";
import { QueryProvider } from "@/lib/query-client";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";
import { GlobalErrorBoundary } from "@/components/providers/GlobalErrorBoundary";
import {
    BRAND_DESCRIPTION,
    BRAND_METADATA_TITLE,
    BRAND_NAME,
} from "@/lib/brand";

const montserrat = Montserrat({
    weight: ["300", "400", "500", "600", "700", "800"],
    subsets: ["latin"],
    display: "swap",
    variable: "--font-montserrat",
});

const polea = localFont({
    src: "../assets/fonts/Polea Extra Bold DEMO.otf",
    display: "swap",
    variable: "--font-polea",
});

// Viewport configuration - separate export for Next.js 14+
export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    maximumScale: 1,
    userScalable: false,
    viewportFit: "cover",
    themeColor: "#000000",
};

export const metadata: Metadata = {
    title: BRAND_METADATA_TITLE,
    description: BRAND_DESCRIPTION,
    manifest: "/manifest.webmanifest",
    icons: {
        icon: "/assets/images/soundspan-favicon.ico",
        apple: [
            { url: "/assets/icons/icon-192.webp", sizes: "192x192" },
            { url: "/assets/icons/icon-512.webp", sizes: "512x512" },
        ],
    },
    appleWebApp: {
        capable: true,
        statusBarStyle: "black-translucent",
        title: BRAND_NAME,
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en">
            <body
                className={`${montserrat.variable} ${polea.variable} antialiased`}
                style={{ fontFamily: "var(--font-montserrat)" }}
            >
                <Script src="/runtime-config" strategy="beforeInteractive" />
                <GlobalErrorBoundary>
                    <ServiceWorkerRegistration />
                    <AuthProvider>
                        <FeaturesProvider>
                            <QueryProvider>
                                <DownloadProvider>
                                    <ConditionalAudioProvider>
                                        <ToastProvider>
                                            <AuthenticatedLayout>
                                                {children}
                                            </AuthenticatedLayout>
                                        </ToastProvider>
                                    </ConditionalAudioProvider>
                                </DownloadProvider>
                            </QueryProvider>
                        </FeaturesProvider>
                    </AuthProvider>
                </GlobalErrorBoundary>
            </body>
        </html>
    );
}
