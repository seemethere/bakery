import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RunningQueueName, RunningQueueState } from "@/hooks/useServerConnection";

type Props = {
  queue: RunningQueueState;
  onCancel: (queue: RunningQueueName, index: number, text?: string) => void;
  onEdit: (text: string) => void;
};

export function RunningQueueStrip({ queue, onCancel, onEdit }: Props) {
  const items = [
    ...queue.steering.map((item, index) => ({ kind: "Steer", queue: "steering" as const, item, index })),
    ...queue.followUp.map((item, index) => ({ kind: "Follow-up", queue: "followUp" as const, item, index })),
  ];
  if (items.length === 0) return null;

  return (
    <div className="relative z-[3] grid justify-center px-4 pt-3" style={{ gridTemplateColumns: "minmax(0, 860px)" }}>
      <section className="grid gap-2 rounded-xl border border-border/50 bg-muted/25 px-3 py-2 text-sm" aria-label="Queued messages">
        <div className="flex items-center justify-between gap-3">
          <strong className="text-xs uppercase text-muted-foreground">Queued for this run</strong>
          <span className="text-xs text-muted-foreground">{items.length} pending</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {items.slice(0, 4).map(({ kind, queue: queueName, item, index }) => (
            <span key={`${queueName}:${index}:${item.text}`} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg border border-border/50 bg-background/70 px-2 py-1 text-xs">
              <strong className="shrink-0">{kind}</strong>
              <button type="button" className="min-w-0 truncate text-left text-muted-foreground hover:text-foreground" title={item.text} onClick={() => onEdit(item.text)}>
                {item.text}
              </button>
              {item.imageCount ? <em className="shrink-0 not-italic text-muted-foreground">+{item.imageCount} img</em> : null}
              <Button type="button" variant="ghost" size="icon-xs" onClick={() => onCancel(queueName, index, item.text)} aria-label={`Cancel ${kind.toLowerCase()} ${index + 1}`} title="Cancel queued message">
                <XIcon />
              </Button>
            </span>
          ))}
          {items.length > 4 && <span className="rounded-lg border border-border/50 bg-background/70 px-2 py-1 text-xs text-muted-foreground">+{items.length - 4} more</span>}
        </div>
      </section>
    </div>
  );
}
