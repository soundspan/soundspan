"use client";

import React, { Component, ReactNode } from "react";
import { createFrontendLogger } from "@/lib/logger";

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

const logger = createFrontendLogger("AudioErrorBoundary");

/**
 * Error boundary specifically for audio-related errors.
 * Catches errors in the audio provider hierarchy.
 * Renders explicit fallback content when provided.
 */
export class AudioErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        // Update state so the next render will show the fallback UI
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        logger.error("Audio system error", error);
        logger.error("Component stack", {
            componentStack: errorInfo.componentStack,
        });
    }

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return null;
        }

        return this.props.children;
    }
}
