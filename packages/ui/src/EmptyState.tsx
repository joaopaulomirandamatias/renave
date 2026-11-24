import type { HTMLAttributes, ReactNode } from "react";

import type { HeadingLevel } from "./PageHeader.js";
import { cx } from "./cx.js";

export interface EmptyStateProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "title"
> {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  headingLevel?: HeadingLevel;
}

export function EmptyState({
  title,
  description,
  actions,
  icon,
  headingLevel = 2,
  className,
  "aria-label": ariaLabel,
  ...rest
}: EmptyStateProps) {
  const HeadingTag = `h${headingLevel}` as const;

  return (
    <section
      {...rest}
      aria-label={ariaLabel ?? title}
      className={cx("sr-empty-state", className)}
    >
      {icon ? (
        <span className="sr-empty-state__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <HeadingTag className="sr-empty-state__title">{title}</HeadingTag>
      {description ? (
        <div className="sr-empty-state__description">{description}</div>
      ) : null}
      {actions ? (
        <div className="sr-empty-state__actions">{actions}</div>
      ) : null}
    </section>
  );
}
