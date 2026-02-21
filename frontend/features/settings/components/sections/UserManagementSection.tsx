"use client";

import { useState, useEffect } from "react";
import { Trash2 } from "lucide-react";
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
    role: "user" | "admin";
    createdAt: string;
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
    const {
        users: connectedUsers,
        isLoading: connectedLoading,
    } = useAdminConnectedUsers(Boolean(isAdmin));

    useEffect(() => {
        loadUsers();
    }, []);

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
                                className="flex items-center justify-between py-3 px-3 rounded-md hover:bg-white/5"
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
                                        </div>
                                    </div>
                                </div>
                                
                                {currentUser?.id !== user.id && (
                                    <button
                                        onClick={() => setConfirmDelete(user.id)}
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
