import { useState, type FormEvent } from "react";

type Props = {
  onCreate: (name: string) => void;
  onJoin: (code: string, name: string) => void;
  error: string;
  connecting: boolean;
};

export function Lobby({ onCreate, onJoin, error, connecting }: Props) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"create" | "join">("create");

  function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === "create") onCreate(name);
    else onJoin(code, name);
  }

  return (
    <div className="lobby">
      <div className="lobby__atmosphere" aria-hidden />
      <div className="lobby__grain" aria-hidden />

      <header className="lobby__brand">
        <p className="lobby__wordmark">Teleparty</p>
        <h1 className="lobby__headline">Watch the same screen. Same second.</h1>
        <p className="lobby__lede">
          Create a room, then either paste a video link or share a screen — everyone watches the
          same thing, with chat and reactions.
        </p>
      </header>

      <form className="lobby__form" onSubmit={submit}>
        <div className="lobby__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "create"}
            className={mode === "create" ? "is-active" : ""}
            onClick={() => setMode("create")}
          >
            Create room
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "join"}
            className={mode === "join" ? "is-active" : ""}
            onClick={() => setMode("join")}
          >
            Join room
          </button>
        </div>

        <label className="field">
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Alex"
            maxLength={24}
            required
            autoComplete="nickname"
          />
        </label>

        {mode === "join" && (
          <label className="field">
            <span>Room code</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABC123"
              maxLength={6}
              required
              autoCapitalize="characters"
              spellCheck={false}
            />
          </label>
        )}

        {error && <p className="lobby__error">{error}</p>}

        <button className="btn-primary" type="submit" disabled={connecting}>
          {connecting ? "Connecting…" : mode === "create" ? "Start watching" : "Enter room"}
        </button>

        <p className="lobby__note">
          Watch together via a direct video URL, or by sharing a screen into the main player.
        </p>
      </form>
    </div>
  );
}
