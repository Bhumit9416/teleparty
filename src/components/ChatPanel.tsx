import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ChatMessage } from "../types";

type Props = {
  messages: ChatMessage[];
  youId: string;
  onSend: (text: string) => void;
};

export function ChatPanel({ messages, youId, onSend }: Props) {
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const clean = text.trim();
    if (!clean) return;
    onSend(clean);
    setText("");
  }

  return (
    <aside className="chat">
      <header className="chat__head">
        <h2>Chat</h2>
      </header>

      <div className="chat__log" role="log" aria-live="polite">
        {messages.length === 0 && (
          <p className="chat__empty">Say hi — reactions live on the video too.</p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`chat__msg ${m.userId === youId ? "is-you" : ""}`}
          >
            <span className="chat__name" style={{ color: m.color }}>
              {m.name}
            </span>
            <p>{m.text}</p>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form className="chat__compose" onSubmit={submit}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Message the room…"
          maxLength={400}
          autoComplete="off"
        />
        <button type="submit" className="btn-primary btn-compact" aria-label="Send">
          Send
        </button>
      </form>
    </aside>
  );
}
