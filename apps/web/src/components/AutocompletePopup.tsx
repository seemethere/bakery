import { useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import type { AutocompleteItem, AutocompleteState } from "@/hooks/useAutocomplete";

type Props = {
  state: AutocompleteState;
  onSelect: (index: number) => void;
};

function ItemLabel({ item }: { item: AutocompleteItem }) {
  if (item.kind === "command") {
    const { name, source, description, argumentHint, unsupported } = item.data;
    return (
      <span className="flex items-baseline gap-2 min-w-0">
        <span className="font-mono font-semibold text-foreground shrink-0">/{name}</span>
        <span className="text-xs text-muted-foreground truncate">
          <strong className="font-medium">{source}</strong>
          {unsupported && <span className="text-yellow-500/80"> · unsupported</span>}
          {argumentHint && <em className="not-italic text-muted-foreground/70"> {argumentHint}</em>}
          {description && <span className="ml-1 opacity-70">{description}</span>}
        </span>
      </span>
    );
  }
  const { path, type } = item.data;
  const isDir = type === "directory";
  return (
    <span className="flex items-center gap-2 min-w-0">
      <span className="shrink-0 text-muted-foreground/60 text-xs">{isDir ? "⌂" : "·"}</span>
      <span className="font-mono text-sm truncate text-foreground">{path}{isDir && !path.endsWith("/") ? "/" : ""}</span>
    </span>
  );
}

export function AutocompletePopup({ state, onSelect }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll selected item into view
  useEffect(() => {
    if (!state) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${state.selectedIndex}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [state?.selectedIndex]);

  if (!state) return null;

  const title = state.loading
    ? state.type === "file" ? "Searching files…" : "Loading commands…"
    : state.items.length === 0
      ? state.type === "file" ? "No matching files" : "No matching commands"
      : state.type === "file" ? "Files" : "Slash commands";

  return (
    <div className={cn(
      "relative z-[2] rounded-xl border border-border/50 bg-card shadow-xl overflow-hidden",
      state.type === "command" && "command-autocomplete",
    )}>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/30 bg-muted/30">
        <span className="text-xs text-muted-foreground">{title}</span>
        <span className="text-[10px] text-muted-foreground/50">
          <kbd className="px-1 py-0.5 rounded bg-muted border border-border/50">↑↓</kbd> navigate &nbsp;
          <kbd className="px-1 py-0.5 rounded bg-muted border border-border/50">Tab</kbd> insert &nbsp;
          <kbd className="px-1 py-0.5 rounded bg-muted border border-border/50">Esc</kbd> close
        </span>
      </div>

      {state.loading && state.items.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted-foreground animate-pulse">Loading…</div>
      ) : state.items.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">No results</div>
      ) : (
        <div ref={listRef} className="max-h-48 overflow-y-auto">
          {state.items.map((item, index) => (
            <button
              key={index}
              data-index={index}
              type="button"
              onMouseDown={(e) => e.preventDefault()} // don't blur textarea
              onClick={() => onSelect(index)}
              className={cn(
                "w-full px-3 py-1.5 text-left text-sm flex items-center",
                "hover:bg-sidebar-accent transition-colors",
                index === state.selectedIndex && "bg-sidebar-primary/10 text-foreground",
              )}
            >
              <ItemLabel item={item} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
