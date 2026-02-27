"use client";

import { useState, useEffect, useCallback } from "react";
import { Trash2, Copy, Check } from "lucide-react";
import { SettingsSection, SettingsInput, SettingsSelect } from "../ui";
import { Modal } from "@/components/ui/Modal";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { createFrontendLogger } from "@/lib/logger";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { useAdminConnectedUsers } from "@/hooks/useSocialPresence";

const logger = createFrontendLogger("Settings.UserManagementSection");

interface User {
    id: string;
    username: string;
    email: string | null;
    role: "user" | "admin";
    createdAt: string;
}

interface InviteCode {
    id: string;
    code: string;
    status: "active" | "expired" | "exhausted" | "revoked";
    maxUses: number;
    useCount: number;
    expiresAt: string | null;
    createdAt: string;
    createdBy: string;
}

export function UserManagementSection() {
    const { user: currentUser } = useAuth();
    const isAdmin = currentUser?.role === "admin";
    const [users, setUsers] = useState<User[]>([]);
    const [newUsername, setNewUsername] = useState("");
    const [newPassword, setNewPassword] = useState("");
    const [newRole, setNewRole] = useState<"user" | "admin">("user");
    const [creating, setCreating] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [createStatus, setCreateStatus] = useState<StatusType>("idle");
    const [createMessage, setCreateMessage] = useState("");
    const [deleteStatus, setDeleteStatus] = useState<StatusType>("idle");
    const [deleteMessage, setDeleteMessage] = useState("");
    const [inviteCodes, setInviteCodes] = useState<InviteCode[]>([]);
    const [inviteTtl, setInviteTtl] = useState("24h");
    const [inviteMaxUses, setInviteMaxUses] = useState("1");
    const [generatingInvite, setGeneratingInvite] = useState(false);
    const [inviteStatus, setInviteStatus] = useState<StatusType>("idle");
    const [inviteMessage, setInviteMessage] = useState("");
    const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
    const [editingUser, setEditingUser] = useState<User | null>(null);
    const [editUsername, setEditUsername] = useState("");
    const [editEmail, setEditEmail] = useState("");
    const [editPassword, setEditPassword] = useState("");
    const [editStatus, setEditStatus] = useState<StatusType>("idle");
    const [editMessage, setEditMessage] = useState("");
    const [savingEdit, setSavingEdit] = useState(false);
    const {
        users: connectedUsers,
        isLoading: connectedLoading,
    } = useAdminConnectedUsers(Boolean(isAdmin));

    const loadInviteCodes = useCallback(async () => {
        try {
            const data = await api.getInviteCodes();
            setInviteCodes(data);
        } catch (error) {
            logger.error("Failed to load invite codes", { error });
        }
    }, []);

    useEffect(() => {
        loadUsers();
        loadInviteCodes();
    }, [loadInviteCodes]);

    const loadUsers = async () => {
        try {
            setLoading(true);
            const data = await api.get<User[]>("/auth/users");
            setUsers(data);
        } catch (error) {
            logger.error("Failed to load users", { error });
        } finally {
            setLoading(false);
        }
    };

    const handleCreate = async () => {
        if (!newUsername.trim() || newPassword.length < 6) {
            setCreateStatus("error");
            setCreateMessage("Username required, password 6+ chars");
            return;
        }

        setCreating(true);
        setCreateStatus("loading");
        try {
            await api.post("/auth/create-user", {
                username: newUsername,
                password: newPassword,
                role: newRole,
            });
            setCreateStatus("success");
            setCreateMessage("Created");
            setNewUsername("");
            setNewPassword("");
            setNewRole("user");
            loadUsers();
        } catch (error: unknown) {
            setCreateStatus("error");
            setCreateMessage(error instanceof Error ? error.message : "Failed");
        } finally {
            setCreating(false);
        }
    };

    const handleDelete = async (userId: string) => {
        setDeleteStatus("loading");
        try {
            await api.delete(`/auth/users/${userId}`);
            setDeleteStatus("success");
            setDeleteMessage("Deleted");
            setConfirmDelete(null);
            loadUsers();
        } catch (error: unknown) {
            setDeleteStatus("error");
            setDeleteMessage(error instanceof Error ? error.message : "Failed");
        }
    };

    const handleGenerateInvite = async () => {
        setGeneratingInvite(true);
        setInviteStatus("loading");
        try {
            const maxUses = parseInt(inviteMaxUses, 10) || 1;
            await api.createInviteCode(inviteTtl, maxUses);
            setInviteStatus("success");
            setInviteMessage("Code generated");
            loadInviteCodes();
        } catch (error: unknown) {
            setInviteStatus("error");
            setInviteMessage(error instanceof Error ? error.message : "Failed");
        } finally {
            setGeneratingInvite(false);
        }
    };

    const handleRevokeInvite = async (id: string) => {
        try {
            await api.revokeInviteCode(id);
            loadInviteCodes();
        } catch (error) {
            logger.error("Failed to revoke invite code", { error });
        }
    };

    const handleCopyInviteLink = (code: string, id: string) => {
        const url = `${window.location.origin}/register?code=${code}`;
        navigator.clipboard.writeText(url);
        setCopiedCodeId(id);
        setTimeout(() => setCopiedCodeId(null), 2000);
    };

    const formatExpiry = (expiresAt: string | null) => {
        if (!expiresAt) return "Never";
        const date = new Date(expiresAt);
        const now = new Date();
        if (date < now) return "Expired";
        const diffMs = date.getTime() - now.getTime();
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffHours / 24);
        if (diffDays > 0) return `${diffDays}d left`;
        if (diffHours > 0) return `${diffHours}h left`;
        return `${Math.floor(diffMs / (1000 * 60))}m left`;
    };

    const statusColor = (status: string) => {
        switch (status) {
            case "active":
                return "text-green-400 bg-green-400/10 border-green-400/20";
            case "expired":
                return "text-yellow-400 bg-yellow-400/10 border-yellow-400/20";
            case "exhausted":
                return "text-blue-400 bg-blue-400/10 border-blue-400/20";
            case "revoked":
                return "text-red-400 bg-red-400/10 border-red-400/20";
            default:
                return "text-gray-400 bg-gray-400/10 border-gray-400/20";
        }
    };

    const openEditModal = (user: User) => {
        setEditingUser(user);
        setEditUsername(user.username);
        setEditEmail(user.email || "");
        setEditPassword("");
        setEditStatus("idle");
        setEditMessage("");
    };

    const closeEditModal = () => {
        setEditingUser(null);
        setEditPassword("");
        setEditStatus("idle");
    };

    const handleEditUser = async () => {
        if (!editingUser) return;

        const payload: Record<string, string> = {};
        if (editUsername.trim() && editUsername !== editingUser.username) {
            payload.username = editUsername.trim();
        }
        if (editEmail.trim() !== (editingUser.email || "")) {
            payload.email = editEmail.trim();
        }
        if (editPassword) {
            if (editPassword.length < 6) {
                setEditStatus("error");
                setEditMessage("Password must be 6+ chars");
                return;
            }
            payload.password = editPassword;
        }

        if (Object.keys(payload).length === 0) {
            setEditStatus("error");
            setEditMessage("No changes");
            return;
        }

        setSavingEdit(true);
        setEditStatus("loading");
        try {
            await api.patch(`/auth/users/${editingUser.id}`, payload);
            setEditStatus("success");
            setEditMessage("Saved");
            loadUsers();
            setTimeout(closeEditModal, 1000);
        } catch (error: unknown) {
            setEditStatus("error");
            setEditMessage(error instanceof Error ? error.message : "Failed");
        } finally {
            setSavingEdit(false);
        }
    };

    if (!isAdmin) {
        return null;
    }

    return (
        <>
            <SettingsSection 
                id="users" 
                title="User Management"
                description="Manage users who can access this instance"
                showSeparator={false}
            >
                {/* Create User Form */}
                <div className="py-4 px-4 bg-[#1a1a1a] rounded-lg mb-4">
                    <h3 className="text-sm font-medium text-white mb-3">Create New User</h3>
                    <div className="space-y-3">
                        <div className="flex gap-3">
                            <SettingsInput
                                value={newUsername}
                                onChange={setNewUsername}
                                placeholder="Username"
                                className="flex-1"
                            />
                            <SettingsInput
                                type="password"
                                value={newPassword}
                                onChange={setNewPassword}
                                placeholder="Password (6+ chars)"
                                className="flex-1"
                            />
                        </div>
                        <div className="inline-flex gap-3 items-center">
                            <SettingsSelect
                                value={newRole}
                                onChange={(v) => setNewRole(v as "user" | "admin")}
                                options={[
                                    { value: "user", label: "User" },
                                    { value: "admin", label: "Admin" },
                                ]}
                            />
                            <button
                                onClick={handleCreate}
                                disabled={creating || !newUsername.trim() || newPassword.length < 6}
                                className="px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full
                                    hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                            >
                                {creating ? "Creating..." : "Create"}
                            </button>
                            <InlineStatus 
                                status={createStatus} 
                                message={createMessage}
                                onClear={() => setCreateStatus("idle")}
                            />
                        </div>
                    </div>
                </div>

                {/* Invite Codes */}
                <div className="py-4 px-4 bg-[#1a1a1a] rounded-lg mb-4">
                    <h3 className="text-sm font-medium text-white mb-3">Invite Codes</h3>
                    <div className="space-y-3">
                        <div className="flex gap-3 items-center flex-wrap">
                            <SettingsSelect
                                value={inviteTtl}
                                onChange={setInviteTtl}
                                options={[
                                    { value: "1h", label: "1 hour" },
                                    { value: "6h", label: "6 hours" },
                                    { value: "24h", label: "24 hours" },
                                    { value: "7d", label: "7 days" },
                                    { value: "30d", label: "30 days" },
                                    { value: "never", label: "Never expires" },
                                ]}
                            />
                            <SettingsInput
                                type="number"
                                value={inviteMaxUses}
                                onChange={setInviteMaxUses}
                                placeholder="Max uses"
                                className="w-24"
                            />
                            <button
                                onClick={handleGenerateInvite}
                                disabled={generatingInvite}
                                className="px-4 py-1.5 text-sm bg-white text-black font-medium rounded-full
                                    hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                            >
                                {generatingInvite ? "Generating..." : "Generate Invite"}
                            </button>
                            <InlineStatus
                                status={inviteStatus}
                                message={inviteMessage}
                                onClear={() => setInviteStatus("idle")}
                            />
                        </div>

                        {inviteCodes.length > 0 && (
                            <div className="space-y-2 mt-3">
                                {inviteCodes.map((code) => (
                                    <div
                                        key={code.id}
                                        className="flex items-center justify-between px-3 py-2 rounded-md bg-white/[0.03] border border-white/5"
                                    >
                                        <div className="flex items-center gap-3 min-w-0">
                                            <code className="text-sm font-mono text-white tracking-wider">
                                                {code.code}
                                            </code>
                                            <span
                                                className={`text-[11px] px-2 py-0.5 rounded-full border capitalize ${statusColor(code.status)}`}
                                            >
                                                {code.status}
                                            </span>
                                            <span className="text-xs text-white/40">
                                                {code.useCount}/{code.maxUses} uses
                                            </span>
                                            <span className="text-xs text-white/40">
                                                {formatExpiry(code.expiresAt)}
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-1">
                                            {code.status === "active" && (
                                                <>
                                                    <button
                                                        onClick={() =>
                                                            handleCopyInviteLink(
                                                                code.code,
                                                                code.id
                                                            )
                                                        }
                                                        className="p-1.5 text-gray-500 hover:text-white transition-colors"
                                                        title="Copy invite link"
                                                    >
                                                        {copiedCodeId === code.id ? (
                                                            <Check className="w-3.5 h-3.5 text-green-400" />
                                                        ) : (
                                                            <Copy className="w-3.5 h-3.5" />
                                                        )}
                                                    </button>
                                                    <button
                                                        onClick={() =>
                                                            handleRevokeInvite(code.id)
                                                        }
                                                        className="p-1.5 text-gray-500 hover:text-red-400 transition-colors"
                                                        title="Revoke invite code"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Connected Users */}
                <div className="py-4 px-4 bg-[#151515] rounded-lg mb-4 border border-white/5">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-medium text-white">
                            Connected Now
                        </h3>
                        <span className="text-xs text-green-400 flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                            {connectedUsers.length} online
                        </span>
                    </div>

                    {connectedLoading ? (
                        <div className="py-2 text-sm text-gray-500">
                            Checking connected users...
                        </div>
                    ) : connectedUsers.length === 0 ? (
                        <div className="py-2 text-sm text-gray-500">
                            No active users connected
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {connectedUsers.map((connectedUser) => (
                                <div
                                    key={connectedUser.id}
                                    className="flex items-center justify-between px-2 py-2 rounded-md bg-white/[0.03]"
                                >
                                    <div className="min-w-0">
                                        <p className="text-sm text-white truncate">
                                            {connectedUser.displayName}
                                            {currentUser?.id === connectedUser.id && (
                                                <span className="text-xs text-gray-500 ml-2">
                                                    (you)
                                                </span>
                                            )}
                                        </p>
                                        <p className="text-xs text-gray-500 truncate">
                                            @{connectedUser.username}
                                        </p>
                                    </div>
                                    <span className="text-[11px] text-white/40 capitalize">
                                        {connectedUser.role}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Users List */}
                <div className="space-y-1">
                    {loading ? (
                        <div className="py-4 text-sm text-gray-500">Loading users...</div>
                    ) : users.length === 0 ? (
                        <div className="py-4 text-sm text-gray-500">No users found</div>
                    ) : (
                        users.map((user) => (
                            <div
                                key={user.id}
                                className="flex items-center justify-between py-3 px-3 rounded-md hover:bg-white/5 cursor-pointer"
                                onClick={() => openEditModal(user)}
                            >
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-full bg-[#333] flex items-center justify-center text-sm text-white">
                                        {user.username[0].toUpperCase()}
                                    </div>
                                    <div>
                                        <div className="text-sm text-white">
                                            {user.username}
                                            {currentUser?.id === user.id && (
                                                <span className="text-xs text-gray-500 ml-2">(you)</span>
                                            )}
                                        </div>
                                        <div className="text-xs text-gray-500">
                                            {user.role === "admin" ? "Admin" : "User"}
                                            {user.email && (
                                                <span className="ml-2">{user.email}</span>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {currentUser?.id !== user.id && (
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setConfirmDelete(user.id);
                                        }}
                                        className="p-2 text-gray-500 hover:text-red-400 transition-colors"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </SettingsSection>

            {/* Edit User Modal */}
            <Modal
                isOpen={!!editingUser}
                onClose={closeEditModal}
                title={`Edit User — ${editingUser?.username}`}
            >
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-white/90 mb-1.5">
                            Username
                        </label>
                        <SettingsInput
                            value={editUsername}
                            onChange={setEditUsername}
                            placeholder="Username"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-white/90 mb-1.5">
                            Email
                        </label>
                        <SettingsInput
                            type="email"
                            value={editEmail}
                            onChange={setEditEmail}
                            placeholder="user@example.com"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-white/90 mb-1.5">
                            New Password
                        </label>
                        <SettingsInput
                            type="password"
                            value={editPassword}
                            onChange={setEditPassword}
                            placeholder="Leave blank to keep current"
                        />
                    </div>
                    <div className="flex gap-2 justify-end items-center">
                        <InlineStatus
                            status={editStatus}
                            message={editMessage}
                            onClear={() => setEditStatus("idle")}
                        />
                        <button
                            onClick={closeEditModal}
                            className="px-4 py-2 text-sm text-gray-400 hover:text-white"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleEditUser}
                            disabled={savingEdit}
                            className="px-4 py-2 text-sm bg-white text-black font-medium rounded-full
                                hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                        >
                            {savingEdit ? "Saving..." : "Save Changes"}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Delete Confirmation Modal */}
            <Modal
                isOpen={!!confirmDelete}
                onClose={() => setConfirmDelete(null)}
                title="Delete User"
            >
                <div className="space-y-4">
                    <p className="text-sm text-gray-300">
                        Are you sure you want to delete this user? This action cannot be undone.
                    </p>
                    <div className="flex gap-2 justify-end items-center">
                        <InlineStatus 
                            status={deleteStatus} 
                            message={deleteMessage}
                            onClear={() => setDeleteStatus("idle")}
                        />
                        <button
                            onClick={() => setConfirmDelete(null)}
                            className="px-4 py-2 text-sm text-gray-400 hover:text-white"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => confirmDelete && handleDelete(confirmDelete)}
                            className="px-4 py-2 text-sm bg-red-500 text-white rounded-full hover:bg-red-600"
                        >
                            Delete
                        </button>
                    </div>
                </div>
            </Modal>
        </>
    );
}
