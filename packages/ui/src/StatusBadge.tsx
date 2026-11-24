import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "./cx.js";

export type StatusBadgeTone =
  "neutral" | "info" | "success" | "warning" | "danger";

export interface StatusBadgeProps extends Omit<
  HTMLAttributes<HTMLSpanElement>,
  "children"
> {
  children: ReactNode;
  tone?: StatusBadgeTone;
  icon?: ReactNode;
}

export function StatusBadge({
  children,
  tone = "neutral",
  icon,
  className,
  ...rest
}: StatusBadgeProps) {
  return (
    <span
      {...rest}
      data-tone={tone}
      className={cx("sr-status-badge", `sr-status-badge--${tone}`, className)}
    >
      {icon ? (
        <span className="sr-status-badge__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span>{children}</span>
    </span>
  );
}
