import bakeryLogo from "@/assets/bakery-logo.png";
import { cn } from "@/lib/utils";

type BrandLogoProps = {
  className?: string;
  imageClassName?: string;
};

function BrandLogo({ className, imageClassName }: BrandLogoProps) {
  return (
    <span
      className={cn(
        "inline-flex aspect-square shrink-0 items-center justify-center overflow-hidden rounded-lg border border-black/10 bg-[#fbfaf4] shadow-sm dark:border-white/15",
        className,
      )}
      aria-hidden="true"
    >
      <img
        src={bakeryLogo}
        alt=""
        className={cn("size-full object-contain p-0.5", imageClassName)}
        draggable={false}
      />
    </span>
  );
}

export { BrandLogo };
