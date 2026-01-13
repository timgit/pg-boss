import { type ReactNode } from "react";

type BadgeVariant =
  | "gray"
  | "primary"
  | "success"
  | "warning"
  | "error";

type BadgeSize = "sm" | "md" | "lg";

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  size?: BadgeSize;
  dot?: boolean;
}

const variantStyles: Record<BadgeVariant, string> = {
  gray: "bg-gray-100 text-gray-700 ring-gray-500/10",
  primary: "bg-primary-50 text-primary-700 ring-primary-600/10",
  success: "bg-success-50 text-success-700 ring-success-600/10",
  warning: "bg-warning-50 text-warning-700 ring-warning-600/10",
  error: "bg-error-50 text-error-700 ring-error-600/10",
};

const dotStyles: Record<BadgeVariant, string> = {
  gray: "bg-gray-500",
  primary: "bg-primary-500",
  success: "bg-success-500",
  warning: "bg-warning-500",
  error: "bg-error-500",
};

const sizeStyles: Record<BadgeSize, string> = {
  sm: "px-2 py-0.5 text-xs",
  md: "px-2.5 py-1 text-xs",
  lg: "px-3 py-1 text-sm",
};

export function Badge({
  children,
  variant = "gray",
  size = "md",
  dot = false,
}: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset ${variantStyles[variant]} ${sizeStyles[size]}`}
    >
      {dot && (
        <span className={`h-1.5 w-1.5 rounded-full ${dotStyles[variant]}`} />
      )}
      {children}
    </span>
  );
}
