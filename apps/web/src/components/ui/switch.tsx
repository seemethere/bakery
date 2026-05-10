import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

function Switch({
  className,
  ...props
}: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-5 w-9 cursor-pointer items-center rounded-full border border-transparent bg-muted p-0.5 shadow-inner outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring/50 data-[checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "block size-4 rounded-full bg-background shadow-sm ring-1 ring-border transition-transform",
          "data-[checked]:translate-x-4 data-[checked]:ring-primary/30",
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
