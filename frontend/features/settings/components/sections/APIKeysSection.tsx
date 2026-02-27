import React, { useEffect, useState } from 'react';
import { useAPIKeys } from '@/features/settings/hooks/useAPIKeys';
import { Modal } from '@/components/ui/Modal';
import { Copy, Trash2 } from 'lucide-react';
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { SettingsSection } from "../ui";

export const APIKeysSection: React.FC = () => {
  const {
    apiKeys,
    loadingApiKeys,
    generatedApiKey,
    showCreateApiKeyDialog,
    setShowCreateApiKeyDialog,
    loadApiKeys,
    createApiKey,
    revokeApiKey,
    clearGeneratedKey,
  } = useAPIKeys();

  const [newApiKeyName, setNewApiKeyName] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [createStatus, setCreateStatus] = useState<StatusType>("idle");
  const [createMessage, setCreateMessage] = useState("");
  const [revokeStatus, setRevokeStatus] = useState<StatusType>("idle");
  const [revokeMessage, setRevokeMessage] = useState("");

  useEffect(() => {
    loadApiKeys();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: API keys should only be loaded once on initial render
  }, []);

  const handleCreateApiKey = async () => {
    if (!newApiKeyName.trim()) {
      setCreateStatus("error");
      setCreateMessage("Name required");
      return;
    }

    setCreating(true);
    setCreateStatus("loading");
    const result = await createApiKey(newApiKeyName);
    if (result.success) {
      setCreateStatus("success");
      setCreateMessage("Created");
      setNewApiKeyName('');
      setShowCreateApiKeyDialog(false);
    } else {
      setCreateStatus("error");
      setCreateMessage(result.error || "Failed");
    }
    setCreating(false);
  };

  const handleRevokeApiKey = async () => {
    if (!confirmRevoke) return;
    
    setRevokeStatus("loading");
    const result = await revokeApiKey(confirmRevoke);
    if (result.success) {
      setRevokeStatus("success");
      setRevokeMessage("Revoked");
      setConfirmRevoke(null);
    } else {
      setRevokeStatus("error");
      setRevokeMessage(result.error || "Failed");
    }
  };

  const handleCopyKey = () => {
    if (generatedApiKey) {
      navigator.clipboard.writeText(generatedApiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDismissKey = () => {
    clearGeneratedKey();
    setCopied(false);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  return (
    <SettingsSection
      id="api-keys"
      title="API Keys"
      description="Manage API keys for programmatic access to your account"
    >

      {/* Generated Key Display */}
      {generatedApiKey && (
        <div className="bg-yellow-900/20 border border-yellow-700/50 rounded-lg p-4 space-y-3">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <h3 className="text-sm font-medium text-yellow-200 mb-2">
                Your new API key
              </h3>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={generatedApiKey}
                  className="flex-1 bg-black/50 border border-yellow-700/50 rounded px-3 py-2 text-sm text-white font-mono"
                />
                <button
                  onClick={handleCopyKey}
                  className="shrink-0 inline-flex items-center gap-1.5 px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full
                    hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Copy className="w-4 h-4" />
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="text-xs text-yellow-200 mt-2">
                Save this key now, you won&apos;t be able to see it again
              </p>
            </div>
          </div>
          <div className="flex justify-end">
            <button
              onClick={handleDismissKey}
              className="px-4 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Create Button */}
      <div>
        <button
          onClick={() => setShowCreateApiKeyDialog(true)}
          className="px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full
            hover:scale-105 transition-transform"
        >
          Generate New API Key
        </button>
      </div>

      {/* API Keys Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[#1c1c1c]">
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">
                Device Name
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">
                Key Preview
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">
                Created
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">
                Last Used
              </th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {loadingApiKeys ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-sm text-gray-400">
                  Loading API keys...
                </td>
              </tr>
            ) : apiKeys.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-sm text-gray-400">
                  No API keys yet
                </td>
              </tr>
            ) : (
              apiKeys.map((key) => (
                <tr
                  key={key.id}
                  className="border-b border-[#1c1c1c] hover:bg-[#0a0a0a]"
                >
                  <td className="py-3 px-4 text-sm text-white">
                    {key.name}
                  </td>
                  <td className="py-3 px-4 text-sm text-gray-400 font-mono">
                    {key.keyPreview}
                  </td>
                  <td className="py-3 px-4 text-sm text-gray-400">
                    {formatDate(key.createdAt)}
                  </td>
                  <td className="py-3 px-4 text-sm text-gray-400">
                    {key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}
                  </td>
                  <td className="py-3 px-4 text-sm">
                    <button
                      onClick={() => setConfirmRevoke(key.id)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-full transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                      Revoke
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Create API Key Dialog */}
      {showCreateApiKeyDialog && (
        <Modal
          isOpen={true}
          onClose={() => {
            setShowCreateApiKeyDialog(false);
            setNewApiKeyName('');
            setCreateStatus("idle");
          }}
          title="Generate New API Key"
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Device Name
              </label>
              <input
                type="text"
                value={newApiKeyName}
                onChange={(e) => setNewApiKeyName(e.target.value)}
                placeholder="e.g., My Laptop, Production Server"
                className="w-full bg-[#0a0a0a] border border-[#1c1c1c] rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
            </div>
            <div className="flex justify-end items-center gap-3">
              <InlineStatus 
                status={createStatus} 
                message={createMessage}
                onClear={() => setCreateStatus("idle")}
              />
              <button
                onClick={() => {
                  setShowCreateApiKeyDialog(false);
                  setNewApiKeyName('');
                  setCreateStatus("idle");
                }}
                disabled={creating}
                className="px-4 py-1.5 text-sm text-gray-400 hover:text-white transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateApiKey}
                disabled={!newApiKeyName.trim() || creating}
                className="px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full
                  hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Revoke Confirmation Modal */}
      {confirmRevoke && (
        <Modal
          isOpen={true}
          onClose={() => {
            setConfirmRevoke(null);
            setRevokeStatus("idle");
          }}
          title="Revoke API Key"
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-300">
              Are you sure you want to revoke this API key? This cannot be undone.
            </p>
            <div className="flex justify-end items-center gap-3">
              <InlineStatus 
                status={revokeStatus} 
                message={revokeMessage}
                onClear={() => setRevokeStatus("idle")}
              />
              <button
                onClick={() => {
                  setConfirmRevoke(null);
                  setRevokeStatus("idle");
                }}
                className="px-4 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRevokeApiKey}
                className="px-4 py-1.5 text-sm bg-red-600 text-white font-medium rounded-full
                  hover:bg-red-700 transition-colors"
              >
                Revoke
              </button>
            </div>
          </div>
        </Modal>
      )}
    </SettingsSection>
  );
};
