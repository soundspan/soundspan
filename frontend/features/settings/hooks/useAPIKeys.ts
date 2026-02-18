import { useState } from "react";
import { api } from "@/lib/api";
import { ApiKey } from "../types";

export function useAPIKeys() {
    const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
    const [loadingApiKeys, setLoadingApiKeys] = useState(false);
    const [showCreateApiKeyDialog, setShowCreateApiKeyDialog] = useState(false);
    const [newApiKeyName, setNewApiKeyName] = useState("");
    const [generatedApiKey, setGeneratedApiKey] = useState<string | null>(null);
    const [creatingApiKey, setCreatingApiKey] = useState(false);

    const loadApiKeys = async () => {
        try {
            setLoadingApiKeys(true);
            const response = await api.listApiKeys();
            // Map API response to match ApiKey type
            const mappedKeys = response.apiKeys.map(key => ({
                ...key,
                lastUsedAt: key.lastUsed,
                keyPreview: key.id.substring(0, 8) + "..." // Generate preview from ID
            }));
            setApiKeys(mappedKeys);
        } catch (error) {
            console.error("Failed to load API keys:", error);
            // Caller handles error display if needed
        } finally {
            setLoadingApiKeys(false);
        }
    };

    /**
     * Create a new API key
     * Returns { success: true } or { success: false, error: string }
     */
    const createApiKey = async (name: string): Promise<{ success: boolean; error?: string }> => {
        const trimmedName = name.trim();
        if (!trimmedName) {
            return { success: false, error: "Device name required" };
        }

        try {
            setCreatingApiKey(true);
            const response = await api.createApiKey(trimmedName);
            setGeneratedApiKey(response.apiKey);
            setShowCreateApiKeyDialog(false);
            setNewApiKeyName("");
            await loadApiKeys();
            return { success: true };
        } catch (error: unknown) {
            console.error("Failed to create API key:", error);
            return { success: false, error: error instanceof Error ? error.message : "Failed to create" };
        } finally {
            setCreatingApiKey(false);
        }
    };

    /**
     * Revoke an API key
     * Returns { success: true } or { success: false, error: string }
     */
    const revokeApiKey = async (id: string): Promise<{ success: boolean; error?: string }> => {
        try {
            await api.revokeApiKey(id);
            await loadApiKeys();
            return { success: true };
        } catch (error: unknown) {
            console.error("Failed to revoke API key:", error);
            return { success: false, error: error instanceof Error ? error.message : "Failed to revoke" };
        }
    };

    const clearGeneratedKey = () => {
        setGeneratedApiKey(null);
    };

    return {
        apiKeys,
        loadingApiKeys,
        showCreateApiKeyDialog,
        newApiKeyName,
        generatedApiKey,
        creatingApiKey,
        setShowCreateApiKeyDialog,
        setNewApiKeyName,
        loadApiKeys,
        createApiKey,
        revokeApiKey,
        clearGeneratedKey,
    };
}
