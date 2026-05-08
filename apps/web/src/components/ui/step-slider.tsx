import { cn } from "@/lib/utils"

type StepSliderOption = {
  value: string;
  label?: string;
}

type StepSliderProps = {
  value: string;
  options: StepSliderOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  "aria-label": string;
  className?: string;
}

function StepSlider({
  value,
  options,
  onValueChange,
  disabled = false,
  "aria-label": ariaLabel,
  className,
}: StepSliderProps) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const isDisabled = disabled || options.length <= 1;

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={isDisabled}
      className={cn(
        "relative flex h-7 w-[148px] items-center rounded-full bg-muted px-2",
        isDisabled && "opacity-50",
        className,
      )}
    >
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        const label = option.label ?? option.value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            disabled={isDisabled}
            onClick={() => {
              if (!selected) onValueChange(option.value);
            }}
            className={cn(
              "flex h-full flex-1 items-center justify-center rounded-full outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring/60",
              "disabled:cursor-not-allowed",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "rounded-full transition-all",
                selected ? "size-[18px] bg-foreground" : "size-[5px] bg-muted-foreground/55",
              )}
            />
          </button>
        );
      })}
    </div>
  )
}

export { StepSlider, type StepSliderOption }
