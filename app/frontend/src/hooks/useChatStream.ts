import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";

export interface Citation {
    paperId?: string;
    paperTitle?: string;
    paperPage?: number;
}
export interface ChatMsg {
    role: "user" | "assistant";
    text: string;
    citations?: Citation[];
}

interface Options {
    chatEndpoint: string;   // POST SSE, e.g. "/manager/chat" or "/me/chat"
    listEndpoint: string;   // GET list,  e.g. "/manager/chats" or "/me/chats"
    greeting: string;
    toolLabels?: Record<string, string>;
    filters?: Record<string, string>;
}

const DEFAULT_TOOL_LABELS: Record<string, string> = {
    get_org_overview: "Reading org overview…",
    get_department_breakdown: "Breaking down by group…",
    get_score_trend: "Checking the trend…",
    get_my_assessments: "Reading your assessments…",
    get_my_score_trend: "Checking your trend…",
    get_my_latest_report: "Opening your last report…",
    search_research: "Consulting research…",
};

/**
 * Headless chat controller shared by the manager and guest assistant widgets:
 * SSE streaming, tool-status, greeting typewriter, latest-chat rehydration and
 * New-chat reset. The caller renders the returned state however it likes.
 */
export function useChatStream({ chatEndpoint, listEndpoint, greeting, toolLabels, filters }: Options) {
    const [messages, setMessages] = useState<ChatMsg[]>([]);
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState("");
    const chatIdRef = useRef<string | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const greetingTimer = useRef<number | null>(null);
    const labels = { ...DEFAULT_TOOL_LABELS, ...(toolLabels ?? {}) };

    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }, [messages, status]);

    const cancelGreeting = () => {
        if (greetingTimer.current) { clearInterval(greetingTimer.current); greetingTimer.current = null; }
    };

    // Type the greeting out letter-by-letter, always finishing well under 2s.
    const typeGreeting = () => {
        cancelGreeting();
        const full = greeting;
        const DURATION = 1400, TICK = 16;
        const perTick = Math.max(1, Math.ceil(full.length / (DURATION / TICK)));
        let i = 0;
        setMessages([{ role: "assistant", text: "" }]);
        greetingTimer.current = window.setInterval(() => {
            i = Math.min(full.length, i + perTick);
            setMessages([{ role: "assistant", text: full.slice(0, i) }]);
            if (i >= full.length) cancelGreeting();
        }, TICK);
    };

    // On mount: restore the latest persisted chat, or type the greeting.
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await apiFetch(listEndpoint, { credentials: "same-origin" });
                if (res.ok) {
                    const { chats } = await res.json();
                    if (alive && chats?.length) {
                        const latest = chats[0].chat_id;
                        const r2 = await apiFetch(`${listEndpoint}/${latest}`, { credentials: "same-origin" });
                        if (r2.ok && alive) {
                            const data = await r2.json();
                            const restored: ChatMsg[] = (data.messages ?? []).map((m: { role: ChatMsg["role"]; content: string; citations?: Citation[] }) => ({
                                role: m.role, text: m.content, citations: m.citations,
                            }));
                            if (alive && restored.length) {
                                chatIdRef.current = latest;
                                setMessages(restored);
                                return;
                            }
                        }
                    }
                }
            } catch {
                /* non-fatal — fall through to the greeting */
            }
            if (alive) typeGreeting();
        })();
        return () => { alive = false; cancelGreeting(); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [listEndpoint]);

    const patchLast = (fn: (m: ChatMsg) => ChatMsg) =>
        setMessages(ms => ms.map((m, i) => (i === ms.length - 1 ? fn(m) : m)));

    const newChat = () => {
        if (busy) return;
        chatIdRef.current = null;
        setInput("");
        setStatus("");
        typeGreeting();
    };

    const send = async () => {
        const text = input.trim();
        if (!text || busy) return;
        setInput("");
        setBusy(true);
        setStatus("Thinking…");
        setMessages(ms => [...ms, { role: "user", text }, { role: "assistant", text: "" }]);

        try {
            const res = await apiFetch(chatEndpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chatId: chatIdRef.current, message: text, filters: filters ?? {} }),
            });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const blocks = buffer.split("\n\n");
                buffer = blocks.pop() ?? "";
                for (const block of blocks) {
                    let event = "message";
                    let data = "";
                    for (const line of block.split("\n")) {
                        if (line.startsWith("event:")) event = line.slice(6).trim();
                        else if (line.startsWith("data:")) data += line.slice(5).trim();
                    }
                    if (!data) continue;
                    let payload: Record<string, unknown> = {};
                    try { payload = JSON.parse(data); } catch { continue; }

                    if (event === "meta") {
                        chatIdRef.current = (payload.chatId as string) ?? chatIdRef.current;
                    } else if (event === "tool") {
                        setStatus(labels[payload.name as string] ?? "Working…");
                    } else if (event === "token") {
                        setStatus("");
                        patchLast(m => ({ ...m, text: m.text + (payload.delta as string) }));
                    } else if (event === "citations") {
                        patchLast(m => ({ ...m, citations: payload.citations as Citation[] }));
                    } else if (event === "error") {
                        patchLast(m => ({ ...m, text: (m.text || "") + `\n\n⚠️ ${payload.message as string}` }));
                    } else if (event === "done") {
                        setStatus("");
                    }
                }
            }
        } catch {
            patchLast(m => ({ ...m, text: m.text || "⚠️ Couldn't reach the assistant. Please try again." }));
        } finally {
            setStatus("");
            setBusy(false);
        }
    };

    return { messages, input, setInput, busy, status, send, newChat, listRef };
}
