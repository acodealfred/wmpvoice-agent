import { useState, useEffect, useRef, useCallback } from "react";
import { Upload, Trash2, Loader2, CheckCircle2, XCircle, RefreshCw, FileText, ShieldCheck, Hash, Database, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KBDocument, AdminUser } from "@/types";

type RegistrationStatus = "unknown" | "loading" | "registered" | "unregistered" | "error";

export function AdminPanel() {
    // ── KB Registration ──────────────────────────────────────────────
    const [regStatus, setRegStatus] = useState<RegistrationStatus>("unknown");
    const [regMessage, setRegMessage] = useState<string>("");
    const [registering, setRegistering] = useState(false);

    const checkRegistration = useCallback(async () => {
        setRegStatus("loading");
        setRegMessage("");
        try {
            const resp = await fetch("/admin/kb/settings", { credentials: "same-origin" });
            if (resp.ok) {
                const data = await resp.json();
                if (typeof data.minCitationsCount === "number") {
                    setRegStatus("registered");
                    setRegMessage(`Registered — minCitationsCount: ${data.minCitationsCount}`);
                } else {
                    setRegStatus("unregistered");
                    setRegMessage("Company not yet registered in Knowledge Base.");
                }
            } else if (resp.status === 401 || resp.status === 403) {
                setRegStatus("error");
                setRegMessage("Unauthorized — MITHRA_APP_TOKEN is missing or invalid in container configuration.");
            } else if (resp.status === 404) {
                // Mithra returns 404 when the company has no KB settings yet (not yet registered)
                setRegStatus("unregistered");
                setRegMessage("Company not yet registered in Knowledge Base. Click Register to set up.");
            } else if (resp.status >= 500) {
                const body = await resp.text().catch(() => "");
                setRegStatus("error");
                setRegMessage(`Backend error (HTTP ${resp.status})${body ? ": " + body.slice(0, 200) : ""}. Check container logs.`);
            } else {
                setRegStatus("unregistered");
                setRegMessage("Company not yet registered in Knowledge Base.");
            }
        } catch {
            setRegStatus("error");
            setRegMessage("Could not reach KB settings endpoint.");
        }
    }, []);

    useEffect(() => {
        checkRegistration();
    }, [checkRegistration]);

    const handleRegister = async () => {
        setRegistering(true);
        setRegMessage("");
        try {
            const resp = await fetch("/admin/kb/settings", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({ minCitationsCount: 1 })
            });
            if (resp.ok) {
                setRegStatus("registered");
                setRegMessage("Company registered successfully (minCitationsCount: 1).");
            } else if (resp.status === 401 || resp.status === 403) {
                setRegStatus("error");
                setRegMessage("Unauthorized — MITHRA_APP_TOKEN is missing or invalid in container configuration.");
            } else if (resp.status === 404) {
                setRegStatus("error");
                setRegMessage("Mithra returned 404. The MITHRA_APP_TOKEN may be missing, or the company does not exist in Mithra yet. Check container env vars.");
            } else {
                const body = await resp.text().catch(() => "");
                setRegStatus("error");
                setRegMessage(`Registration failed (HTTP ${resp.status})${body ? ": " + body.slice(0, 200) : ""}`);
            }
        } catch {
            setRegStatus("error");
            setRegMessage("Network error during registration.");
        } finally {
            setRegistering(false);
        }
    };

    // ── Document list — live from Mithra via papers/search ───────────
    const [documents, setDocuments] = useState<KBDocument[]>([]);
    const [docsLoading, setDocsLoading] = useState(false);
    const [docsError, setDocsError] = useState<string | null>(null);

    const fetchDocuments = useCallback(async () => {
        setDocsLoading(true);
        setDocsError(null);
        try {
            const resp = await fetch("/admin/kb/papers/search", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({ limit: 100 }),
            });
            if (resp.ok) {
                const data = await resp.json();
                const papers: KBDocument[] = (data.papers ?? []).map((p: {
                    id: string; title: string; updatedAt?: string;
                    lifeCycleState?: string;
                    contentMetadata?: { sizeSi?: string; type?: string };
                }) => ({
                    paperId: p.id,
                    title: p.title,
                    uploadedAt: p.updatedAt ?? "",
                    lifeCycleState: p.lifeCycleState,
                    sizeSi: p.contentMetadata?.sizeSi,
                    fileType: p.contentMetadata?.type,
                }));
                setDocuments(papers);
            } else if (resp.status === 401 || resp.status === 403) {
                setDocsError("Unauthorized — check MITHRA_APP_TOKEN.");
            } else {
                const body = await resp.text().catch(() => "");
                setDocsError(`Failed to load documents (HTTP ${resp.status})${body ? ": " + body.slice(0, 120) : ""}`);
            }
        } catch {
            setDocsError("Network error loading document list.");
        } finally {
            setDocsLoading(false);
        }
    }, []);

    useEffect(() => { fetchDocuments(); }, [fetchDocuments]);

    // ── User Management ───────────────────────────────────────────────
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [usersLoading, setUsersLoading] = useState(false);
    const [usersError, setUsersError] = useState<string | null>(null);

    const fetchUsers = useCallback(async () => {
        setUsersLoading(true);
        setUsersError(null);
        try {
            const resp = await fetch("/admin/users", { credentials: "same-origin" });
            if (resp.ok) {
                const data = await resp.json();
                setUsers(data.users);
            } else {
                setUsersError("Failed to load users.");
            }
        } catch {
            setUsersError("Network error.");
        } finally {
            setUsersLoading(false);
        }
    }, []);

    useEffect(() => { fetchUsers(); }, [fetchUsers]);

    // ── Upload Document ───────────────────────────────────────────────
    const [uploadTitle, setUploadTitle] = useState("");
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadMsg, setUploadMsg] = useState<{ text: string; ok: boolean } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleUpload = async () => {
        if (!uploadFile) {
            setUploadMsg({ text: "Please select a file.", ok: false });
            return;
        }
        // Use the typed title, or fall back to the filename without extension
        const effectiveTitle = uploadTitle.trim() || uploadFile.name.replace(/\.[^/.]+$/, "");
        setUploading(true);
        setUploadMsg(null);
        try {
            const form = new FormData();
            form.append("title", effectiveTitle);
            form.append("file", uploadFile);

            const resp = await fetch("/admin/kb/upload", { method: "POST", credentials: "same-origin", body: form });
            const data = await resp.json();

            if (resp.ok) {
                setUploadTitle("");
                setUploadFile(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
                setUploadMsg({ text: `Uploaded successfully — paperId: ${data.id}`, ok: true });
                await fetchDocuments(); // refresh list from server
            } else {
                setUploadMsg({ text: data.message || data.error || `Upload failed (HTTP ${resp.status}).`, ok: false });
            }
        } catch {
            setUploadMsg({ text: "Network error during upload.", ok: false });
        } finally {
            setUploading(false);
        }
    };

    // ── Delete Document ───────────────────────────────────────────────
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [deleteMsg, setDeleteMsg] = useState<{ paperId: string; text: string; ok: boolean } | null>(null);

    const handleDelete = async (doc: KBDocument) => {
        setDeletingId(doc.paperId);
        setDeleteMsg(null);
        try {
            const resp = await fetch(`/admin/kb/documents/${doc.paperId}`, { method: "DELETE", credentials: "same-origin" });
            if (resp.status === 204 || resp.ok) {
                setDeleteMsg({ paperId: doc.paperId, text: `"${doc.title}" deleted.`, ok: true });
                await fetchDocuments(); // refresh from server
            } else {
                const err = await resp.json().catch(() => ({}));
                setDeleteMsg({ paperId: doc.paperId, text: err.message || `Delete failed (HTTP ${resp.status}).`, ok: false });
            }
        } catch {
            setDeleteMsg({ paperId: doc.paperId, text: "Network error during delete.", ok: false });
        } finally {
            setDeletingId(null);
        }
    };

    // ── Render ─────────────────────────────────────────────────────────
    return (
        <div className="space-y-6 p-6">

            {/* ── Section A: KB Registration ── */}
            <div className="rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-5 shadow-md">
                <div className="mb-4 flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5 text-purple-400" />
                    <h2 className="text-base font-semibold text-[color:var(--ciq-text-strong)]">Knowledge Base Registration</h2>
                </div>

                <div className="mb-4 flex items-center gap-3">
                    {regStatus === "loading" && <Loader2 className="h-4 w-4 animate-spin text-[color:var(--ciq-text-muted)]" />}
                    {regStatus === "registered" && <CheckCircle2 className="h-4 w-4 text-green-400" />}
                    {(regStatus === "unregistered" || regStatus === "error") && <XCircle className="h-4 w-4 text-amber-400" />}
                    {regStatus === "unknown" && <span className="h-4 w-4" />}
                    <span className={`text-sm ${regStatus === "registered" ? "text-green-300" : regStatus === "error" ? "text-red-300" : "text-[color:var(--ciq-text-body)]"}`}>
                        {regStatus === "loading" ? "Checking registration…" : regMessage || "—"}
                    </span>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={checkRegistration}
                        disabled={regStatus === "loading"}
                        className="ml-auto border-[color:var(--ciq-line)] bg-transparent text-[color:var(--ciq-text-body)] hover:bg-[color:var(--ciq-card-2)]"
                    >
                        <RefreshCw className="mr-1 h-3 w-3" />
                        Refresh
                    </Button>
                </div>

                {regStatus !== "registered" && (
                    <Button
                        onClick={handleRegister}
                        disabled={registering || regStatus === "loading"}
                        className="bg-purple-600 text-white hover:bg-purple-700"
                    >
                        {registering ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        {registering ? "Registering…" : "Register Company"}
                    </Button>
                )}
            </div>

            {/* ── Section B: Upload Document ── */}
            <div className="rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-5 shadow-md">
                <div className="mb-4 flex items-center gap-2">
                    <Upload className="h-5 w-5 text-purple-400" />
                    <h2 className="text-base font-semibold text-[color:var(--ciq-text-strong)]">Upload Document</h2>
                </div>

                <div className="space-y-3">
                    <div>
                        <label className="mb-1 block text-xs font-medium text-[color:var(--ciq-text-muted)]">Document Title</label>
                        <input
                            type="text"
                            value={uploadTitle}
                            onChange={e => setUploadTitle(e.target.value)}
                            placeholder="e.g. Company Policy 2025"
                            className="w-full rounded-md border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] px-3 py-2 text-sm text-[color:var(--ciq-text-strong)] placeholder-slate-500 focus:border-purple-500 focus:outline-none"
                        />
                    </div>
                    <div>
                        <label className="mb-1 block text-xs font-medium text-[color:var(--ciq-text-muted)]">
                            File (PDF, DOCX, TXT)
                            <span className="ml-1 text-purple-400">*</span>
                        </label>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".pdf,.docx,.txt"
                            onChange={e => {
                                const file = e.target.files?.[0] ?? null;
                                setUploadFile(file);
                                // Auto-fill title from filename if the title field is still empty
                                if (file && !uploadTitle.trim()) {
                                    const nameWithoutExt = file.name.replace(/\.[^/.]+$/, "");
                                    setUploadTitle(nameWithoutExt);
                                }
                            }}
                            className="w-full text-sm text-[color:var(--ciq-text-body)] file:mr-3 file:rounded file:border-0 file:bg-purple-600 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-purple-700"
                        />
                        {uploadFile && (
                            <p className="mt-1 text-xs text-[color:var(--ciq-text-muted)]">
                                {uploadFile.name} ({(uploadFile.size / 1024).toFixed(1)} KB)
                            </p>
                        )}
                    </div>

                    <Button
                        onClick={handleUpload}
                        disabled={uploading || !uploadFile}
                        className="bg-purple-600 text-white hover:bg-purple-700"
                    >
                        {uploading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
                        {uploading ? "Uploading…" : "Upload to Knowledge Base"}
                    </Button>

                    {uploadMsg && (
                        <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${uploadMsg.ok ? "bg-green-900/40 text-green-300" : "bg-red-900/40 text-red-300"}`}>
                            {uploadMsg.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                            {uploadMsg.text}
                        </div>
                    )}
                </div>
            </div>

            {/* ── Section C: Document List (live from Mithra) ── */}
            <div className="rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-5 shadow-md">
                <div className="mb-4 flex items-center gap-2">
                    <Database className="h-5 w-5 text-purple-400" />
                    <h2 className="text-base font-semibold text-[color:var(--ciq-text-strong)]">Knowledge Base Documents</h2>
                    {!docsLoading && (
                        <span className="rounded-full bg-[color:var(--ciq-card-3)] px-2 py-0.5 text-xs text-[color:var(--ciq-text-body)]">
                            {documents.length} file{documents.length !== 1 ? "s" : ""}
                        </span>
                    )}
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={fetchDocuments}
                        disabled={docsLoading}
                        className="ml-auto border-[color:var(--ciq-line)] bg-transparent text-[color:var(--ciq-text-body)] hover:bg-[color:var(--ciq-card-2)]"
                    >
                        {docsLoading
                            ? <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            : <RefreshCw className="mr-1 h-3 w-3" />}
                        Refresh
                    </Button>
                </div>

                {docsError && (
                    <div className="mb-3 flex items-center gap-2 rounded-md bg-red-900/40 px-3 py-2 text-sm text-red-300">
                        <XCircle className="h-4 w-4 shrink-0" />
                        {docsError}
                    </div>
                )}

                {docsLoading && documents.length === 0 ? (
                    <div className="flex items-center gap-2 text-sm text-[color:var(--ciq-text-muted)]">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading documents from Knowledge Base…
                    </div>
                ) : documents.length === 0 && !docsError ? (
                    <p className="text-sm text-[color:var(--ciq-text-muted)]">No documents found in the Knowledge Base. Upload a file above to get started.</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse text-sm">
                            <thead>
                                <tr className="bg-[color:var(--ciq-card-2)] text-left text-xs text-[color:var(--ciq-text-muted)]">
                                    <th className="border border-[color:var(--ciq-line)] px-3 py-2">Title</th>
                                    <th className="border border-[color:var(--ciq-line)] px-3 py-2 hidden sm:table-cell">Paper ID</th>
                                    <th className="border border-[color:var(--ciq-line)] px-3 py-2 hidden md:table-cell">Size</th>
                                    <th className="border border-[color:var(--ciq-line)] px-3 py-2 hidden md:table-cell">State</th>
                                    <th className="border border-[color:var(--ciq-line)] px-3 py-2 hidden lg:table-cell">Updated</th>
                                    <th className="border border-[color:var(--ciq-line)] px-3 py-2 text-center">Delete</th>
                                </tr>
                            </thead>
                            <tbody>
                                {documents.map((doc, i) => (
                                    <tr key={doc.paperId} className={i % 2 === 0 ? "bg-[color:var(--ciq-card)]" : "bg-[color:var(--ciq-card-2)]"}>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-2">
                                            <div className="flex items-center gap-2">
                                                <FileText className="h-3.5 w-3.5 shrink-0 text-purple-400" />
                                                <span className="font-medium text-[color:var(--ciq-text-strong)]">{doc.title}</span>
                                            </div>
                                        </td>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-2 hidden sm:table-cell">
                                            <span className="font-mono text-xs text-[color:var(--ciq-text-muted)]">{doc.paperId}</span>
                                        </td>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-2 hidden md:table-cell text-xs text-[color:var(--ciq-text-muted)]">
                                            {doc.sizeSi ?? "—"}
                                        </td>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-2 hidden md:table-cell">
                                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                                doc.lifeCycleState === "active"
                                                    ? "bg-green-900/50 text-green-300"
                                                    : "bg-[color:var(--ciq-card-3)] text-[color:var(--ciq-text-muted)]"
                                            }`}>
                                                {doc.lifeCycleState ?? "—"}
                                            </span>
                                        </td>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-2 hidden lg:table-cell text-xs text-[color:var(--ciq-text-muted)]">
                                            {doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleString() : "—"}
                                        </td>
                                        <td className="border border-[color:var(--ciq-line)] px-3 py-2 text-center">
                                            <Button
                                                variant="destructive"
                                                size="sm"
                                                onClick={() => handleDelete(doc)}
                                                disabled={deletingId === doc.paperId}
                                                className="h-7 px-2"
                                            >
                                                {deletingId === doc.paperId
                                                    ? <Loader2 className="h-3 w-3 animate-spin" />
                                                    : <Trash2 className="h-3 w-3" />}
                                            </Button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>

                        {deleteMsg && (
                            <div className={`mt-3 flex items-center gap-2 rounded-md px-3 py-2 text-sm ${deleteMsg.ok ? "bg-green-900/40 text-green-300" : "bg-red-900/40 text-red-300"}`}>
                                {deleteMsg.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                                {deleteMsg.text}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* ── Section D: Delete by Paper ID ── */}
            <DeleteByPaperId onDeleted={fetchDocuments} />

            {/* ── Section E: User Management ── */}
            <div className="rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-5 shadow-md">
                <div className="mb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Users className="h-5 w-5 text-purple-400" />
                        <h2 className="text-base font-semibold text-[color:var(--ciq-text-strong)]">User Management</h2>
                        {!usersLoading && (
                            <span className="rounded-full bg-[color:var(--ciq-card-3)] px-2 py-0.5 text-xs font-medium text-[color:var(--ciq-text-body)]">
                                {users.length}
                            </span>
                        )}
                    </div>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={fetchUsers}
                        disabled={usersLoading}
                        className="border-[color:var(--ciq-line)] bg-transparent text-[color:var(--ciq-text-body)] hover:bg-[color:var(--ciq-card-2)]"
                    >
                        <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${usersLoading ? "animate-spin" : ""}`} />
                        Refresh
                    </Button>
                </div>

                {usersError && (
                    <div className="mb-3 flex items-center gap-2 rounded-md bg-red-900/40 px-3 py-2 text-sm text-red-300">
                        <XCircle className="h-4 w-4 shrink-0" />
                        {usersError}
                    </div>
                )}

                {usersLoading && users.length === 0 ? (
                    <div className="flex items-center justify-center py-8 text-[color:var(--ciq-text-muted)]">
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Loading users…
                    </div>
                ) : users.length === 0 ? (
                    <p className="py-6 text-center text-sm text-[color:var(--ciq-text-muted)]">No users found.</p>
                ) : (
                    <div className="overflow-x-auto rounded-lg border border-[color:var(--ciq-line)]">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="bg-[color:var(--ciq-card-2)] text-xs font-medium uppercase tracking-wide text-[color:var(--ciq-text-muted)]">
                                    <th className="px-4 py-3 text-left">User</th>
                                    <th className="px-4 py-3 text-center">Sessions</th>
                                    <th className="hidden px-4 py-3 text-left sm:table-cell">Last Session ID</th>
                                    <th className="hidden px-4 py-3 text-left md:table-cell">Last Active</th>
                                    <th className="hidden px-4 py-3 text-left lg:table-cell">Member Since</th>
                                </tr>
                            </thead>
                            <tbody>
                                {users.map((u, i) => (
                                    <tr
                                        key={u.user_id}
                                        className={i % 2 === 0 ? "bg-[color:var(--ciq-card)]" : "bg-[color:var(--ciq-card-2)]"}
                                    >
                                        <td className="px-4 py-3 font-medium text-[color:var(--ciq-text-strong)]">{u.name}</td>
                                        <td className="px-4 py-3 text-center">
                                            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                                                u.session_count > 0
                                                    ? "bg-purple-900/50 text-purple-300"
                                                    : "bg-[color:var(--ciq-card-3)] text-[color:var(--ciq-text-muted)]"
                                            }`}>
                                                {u.session_count}
                                            </span>
                                        </td>
                                        <td className="hidden px-4 py-3 sm:table-cell">
                                            {u.last_session_id ? (
                                                <span className="font-mono text-xs text-[color:var(--ciq-text-muted)]">
                                                    {u.last_session_id.slice(0, 8)}…
                                                </span>
                                            ) : (
                                                <span className="text-[color:var(--ciq-text-body)]">—</span>
                                            )}
                                        </td>
                                        <td className="hidden px-4 py-3 text-[color:var(--ciq-text-muted)] md:table-cell">
                                            {u.last_active_at
                                                ? new Date(u.last_active_at).toLocaleString()
                                                : <span className="text-[color:var(--ciq-text-body)]">—</span>
                                            }
                                        </td>
                                        <td className="hidden px-4 py-3 text-[color:var(--ciq-text-muted)] lg:table-cell">
                                            {new Date(u.created_at).toLocaleDateString()}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Standalone Delete-by-ID widget ──────────────────────────────────────────
function DeleteByPaperId({ onDeleted }: { onDeleted: () => void }) {
    const [paperId, setPaperId] = useState("");
    const [deleting, setDeleting] = useState(false);
    const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

    const handleDelete = async () => {
        const id = paperId.trim();
        if (!id) return;
        setDeleting(true);
        setMsg(null);
        try {
            const resp = await fetch(`/admin/kb/documents/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" });
            if (resp.status === 204 || resp.ok) {
                setMsg({ text: `Document ${id} deleted successfully.`, ok: true });
                setPaperId("");
                onDeleted();
            } else {
                const err = await resp.json().catch(() => ({}));
                setMsg({ text: err.message || err.error || `Delete failed (HTTP ${resp.status}).`, ok: false });
            }
        } catch {
            setMsg({ text: "Network error during delete.", ok: false });
        } finally {
            setDeleting(false);
        }
    };

    return (
        <div className="rounded-xl border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card)] p-5 shadow-md">
            <div className="mb-4 flex items-center gap-2">
                <Hash className="h-5 w-5 text-purple-400" />
                <h2 className="text-base font-semibold text-[color:var(--ciq-text-strong)]">Delete by Paper ID</h2>
            </div>
            <p className="mb-3 text-xs text-[color:var(--ciq-text-muted)]">
                Use this to delete a document from the Knowledge Base using its Paper ID directly —
                useful for documents uploaded from another device or before tracking was enabled.
            </p>
            <div className="flex gap-2">
                <input
                    type="text"
                    value={paperId}
                    onChange={e => setPaperId(e.target.value)}
                    placeholder="Paste paper ID…"
                    className="flex-1 rounded-md border border-[color:var(--ciq-line)] bg-[color:var(--ciq-card-2)] px-3 py-2 text-sm text-[color:var(--ciq-text-strong)] placeholder-slate-500 focus:border-purple-500 focus:outline-none"
                    onKeyDown={e => e.key === "Enter" && !deleting && paperId.trim() && handleDelete()}
                />
                <Button
                    variant="destructive"
                    onClick={handleDelete}
                    disabled={deleting || !paperId.trim()}
                >
                    {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                </Button>
            </div>
            {msg && (
                <div className={`mt-2 flex items-center gap-2 rounded-md px-3 py-2 text-sm ${msg.ok ? "bg-green-900/40 text-green-300" : "bg-red-900/40 text-red-300"}`}>
                    {msg.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                    {msg.text}
                </div>
            )}
        </div>
    );
}
