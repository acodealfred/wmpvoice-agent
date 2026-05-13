import { useState, useEffect, useRef, useCallback } from "react";
import { Upload, Trash2, Loader2, CheckCircle2, XCircle, RefreshCw, FileText, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KBDocument } from "@/types";

const KB_DOCS_KEY = "ciq_kb_documents";

function loadDocuments(): KBDocument[] {
    try {
        const raw = localStorage.getItem(KB_DOCS_KEY);
        return raw ? (JSON.parse(raw) as KBDocument[]) : [];
    } catch {
        return [];
    }
}

function saveDocuments(docs: KBDocument[]) {
    localStorage.setItem(KB_DOCS_KEY, JSON.stringify(docs));
}

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
            const resp = await fetch("/admin/kb/settings");
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

    // ── Upload Document ───────────────────────────────────────────────
    const [uploadTitle, setUploadTitle] = useState("");
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadMsg, setUploadMsg] = useState<{ text: string; ok: boolean } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [documents, setDocuments] = useState<KBDocument[]>(loadDocuments);

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

            const resp = await fetch("/admin/kb/upload", { method: "POST", body: form });
            const data = await resp.json();

            if (resp.ok) {
                const newDoc: KBDocument = {
                    paperId: data.id,
                    title: data.title || uploadTitle.trim(),
                    uploadedAt: new Date().toISOString()
                };
                const updated = [...documents, newDoc];
                setDocuments(updated);
                saveDocuments(updated);
                setUploadTitle("");
                setUploadFile(null);
                if (fileInputRef.current) fileInputRef.current.value = "";
                setUploadMsg({ text: `Uploaded successfully — paperId: ${data.id}`, ok: true });
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
            const resp = await fetch(`/admin/kb/documents/${doc.paperId}`, { method: "DELETE" });
            if (resp.status === 204 || resp.ok) {
                const updated = documents.filter(d => d.paperId !== doc.paperId);
                setDocuments(updated);
                saveDocuments(updated);
                setDeleteMsg({ paperId: doc.paperId, text: `"${doc.title}" deleted.`, ok: true });
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
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-md">
                <div className="mb-4 flex items-center gap-2">
                    <ShieldCheck className="h-5 w-5 text-purple-400" />
                    <h2 className="text-base font-semibold text-white">Knowledge Base Registration</h2>
                </div>

                <div className="mb-4 flex items-center gap-3">
                    {regStatus === "loading" && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
                    {regStatus === "registered" && <CheckCircle2 className="h-4 w-4 text-green-400" />}
                    {(regStatus === "unregistered" || regStatus === "error") && <XCircle className="h-4 w-4 text-amber-400" />}
                    {regStatus === "unknown" && <span className="h-4 w-4" />}
                    <span className={`text-sm ${regStatus === "registered" ? "text-green-300" : regStatus === "error" ? "text-red-300" : "text-slate-300"}`}>
                        {regStatus === "loading" ? "Checking registration…" : regMessage || "—"}
                    </span>
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={checkRegistration}
                        disabled={regStatus === "loading"}
                        className="ml-auto border-slate-600 bg-transparent text-slate-300 hover:bg-slate-800"
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
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-md">
                <div className="mb-4 flex items-center gap-2">
                    <Upload className="h-5 w-5 text-purple-400" />
                    <h2 className="text-base font-semibold text-white">Upload Document</h2>
                </div>

                <div className="space-y-3">
                    <div>
                        <label className="mb-1 block text-xs font-medium text-slate-400">Document Title</label>
                        <input
                            type="text"
                            value={uploadTitle}
                            onChange={e => setUploadTitle(e.target.value)}
                            placeholder="e.g. Company Policy 2025"
                            className="w-full rounded-md border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-purple-500 focus:outline-none"
                        />
                    </div>
                    <div>
                        <label className="mb-1 block text-xs font-medium text-slate-400">
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
                            className="w-full text-sm text-slate-300 file:mr-3 file:rounded file:border-0 file:bg-purple-600 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-purple-700"
                        />
                        {uploadFile && (
                            <p className="mt-1 text-xs text-slate-400">
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

            {/* ── Section C: Document List ── */}
            <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 shadow-md">
                <div className="mb-4 flex items-center gap-2">
                    <FileText className="h-5 w-5 text-purple-400" />
                    <h2 className="text-base font-semibold text-white">Uploaded Documents</h2>
                    <span className="ml-auto rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
                        {documents.length} file{documents.length !== 1 ? "s" : ""}
                    </span>
                </div>

                {documents.length === 0 ? (
                    <p className="text-sm text-slate-500">No documents uploaded yet. Upload a file above to get started.</p>
                ) : (
                    <div className="space-y-2">
                        {documents.map(doc => (
                            <div
                                key={doc.paperId}
                                className="flex items-center gap-3 rounded-lg border border-slate-700 bg-slate-800 px-4 py-3"
                            >
                                <FileText className="h-4 w-4 shrink-0 text-purple-400" />
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium text-white">{doc.title}</p>
                                    <p className="text-xs text-slate-500">
                                        ID: {doc.paperId} · {new Date(doc.uploadedAt).toLocaleString()}
                                    </p>
                                </div>
                                <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={() => handleDelete(doc)}
                                    disabled={deletingId === doc.paperId}
                                    className="shrink-0"
                                >
                                    {deletingId === doc.paperId
                                        ? <Loader2 className="h-3 w-3 animate-spin" />
                                        : <Trash2 className="h-3 w-3" />}
                                </Button>
                            </div>
                        ))}

                        {deleteMsg && (
                            <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm ${deleteMsg.ok ? "bg-green-900/40 text-green-300" : "bg-red-900/40 text-red-300"}`}>
                                {deleteMsg.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                                {deleteMsg.text}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
