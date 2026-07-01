import { useRef, useState, useEffect } from "react";

interface Msg {
    role: "user" | "assistant";
    text: string;
}

const GREETING: Msg = {
    role: "assistant",
    text: "Hi! I'm the wellbeing assistant. Ask me about the org's burnout trends and I'll help you read the dashboard. (Assistant isn't wired up yet — responses are placeholders.)",
};

// UI-only placeholder — no backend call. A canned reply stands in until the
// real LLM endpoint is connected.
export function ManagerChat() {
    const [messages, setMessages] = useState<Msg[]>([GREETING]);
    const [input, setInput] = useState("");
    const listRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    }, [messages]);

    const send = () => {
        const text = input.trim();
        if (!text) return;
        setMessages(m => [
            ...m,
            { role: "user", text },
            { role: "assistant", text: "Thanks — the assistant isn't connected yet, so this is a placeholder response. Once wired up I'll answer using the de-identified dashboard data." },
        ]);
        setInput("");
    };

    return (
        <div className="ml-card ml-pad ml-chat">
            <div className="ml-sec-h">
                <h2>Wellbeing Assistant</h2>
                <span className="ml-badge ml-b-muted">Preview</span>
            </div>

            <div className="ml-chat-log" ref={listRef}>
                {messages.map((m, i) => (
                    <div key={i} className={`ml-chat-msg ml-chat-${m.role}`}>
                        <div className="ml-chat-bubble">{m.text}</div>
                    </div>
                ))}
            </div>

            <div className="ml-chat-input">
                <input
                    type="text"
                    value={input}
                    placeholder="Ask about burnout trends…"
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") send(); }}
                />
                <button onClick={send} aria-label="Send" disabled={!input.trim()}>Send</button>
            </div>
        </div>
    );
}
