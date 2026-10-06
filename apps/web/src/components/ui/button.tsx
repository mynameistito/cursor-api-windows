import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap border border-transparent transition-colors outline-none focus-visible:shadow-[var(--focus-ring)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-[var(--geist-gray-100)] disabled:text-[var(--geist-gray-700)] aria-invalid:border-destructive aria-invalid:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--destructive)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "h-10 px-2.5 py-2 has-[>svg]:px-2.5",
        icon: "size-10",
        "icon-lg": "size-10",
        "icon-sm": "size-8",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        lg: "h-12 rounded-md px-3.5 text-base has-[>svg]:px-3.5",
        sm: "h-8 gap-1.5 rounded-md px-1.5 has-[>svg]:px-1.5",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
      },
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-[color-mix(in_oklab,var(--primary)_92%,var(--background))]",
        destructive:
          "bg-destructive text-white hover:bg-[color-mix(in_oklab,var(--destructive)_90%,var(--background))]",
        ghost:
          "text-foreground hover:bg-[var(--geist-gray-alpha-100)] hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        outline:
          "border-border bg-background text-foreground hover:border-[var(--geist-gray-alpha-500)] hover:bg-[var(--geist-gray-alpha-100)]",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[var(--geist-gray-200)]",
      },
    },
  }
);

const Button = ({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) => {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ className, size, variant }))}
      {...props}
    />
  );
};

export { Button };
