import type { FloatingReaction } from "../types";

type Props = {
  reactions: FloatingReaction[];
};

export function ReactionBurst({ reactions }: Props) {
  return (
    <div className="bursts" aria-hidden>
      {reactions.map((r) => (
        <span
          key={r.id}
          className="burst"
          style={{ left: `${r.x}%`, ["--tint" as string]: r.color }}
        >
          <span className="burst__emoji">{r.emoji}</span>
          <span className="burst__name">{r.name}</span>
        </span>
      ))}
    </div>
  );
}
