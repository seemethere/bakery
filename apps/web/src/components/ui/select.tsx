import { Select as SelectPrimitive } from "@base-ui/react/select"
import { Check, ChevronDown } from "lucide-react"

import { cn } from "@/lib/utils"

function Select({
  modal = false,
  ...props
}: SelectPrimitive.Root.Props<string>) {
  return <SelectPrimitive.Root modal={modal} {...props} />
}

function SelectTrigger({
  className,
  children,
  ...props
}: SelectPrimitive.Trigger.Props) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "inline-flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground shadow-sm",
        "outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="text-muted-foreground">
        <ChevronDown className="size-4" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  )
}

function SelectValue(props: SelectPrimitive.Value.Props) {
  return <SelectPrimitive.Value {...props} />
}

function SelectContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: SelectPrimitive.Popup.Props & Pick<SelectPrimitive.Positioner.Props, "sideOffset">) {
  return (
    <SelectPrimitive.Positioner sideOffset={sideOffset} className="z-[90]" alignItemWithTrigger={false}>
      <SelectPrimitive.Popup
        className={cn(
          "grid min-w-[var(--anchor-width)] max-h-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl",
          "outline-none data-[ending-style]:animate-out data-[ending-style]:fade-out-0 data-[starting-style]:animate-in data-[starting-style]:fade-in-0",
          className,
        )}
        {...props}
      >
        {children}
      </SelectPrimitive.Popup>
    </SelectPrimitive.Positioner>
  )
}

function SelectItem({
  className,
  children,
  selected,
  ...props
}: SelectPrimitive.Item.Props & { selected?: boolean }) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "grid cursor-pointer grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
        "hover:bg-muted/60 data-[selected]:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        selected && "bg-muted text-foreground",
        className,
      )}
      {...props}
    >
      <span className="flex size-4 items-center justify-center">
        {selected && <Check className="size-4 text-primary" />}
      </span>
      <SelectPrimitive.ItemText className="truncate">{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  )
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue }
