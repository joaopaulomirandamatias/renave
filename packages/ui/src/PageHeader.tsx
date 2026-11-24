import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "./cx.js";

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface PageHeaderProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "title"
> {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  headingLevel?: HeadingLevel;
}

export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  icon,
  headingLevel = 1,
  className,
  ...rest
}: PageHeaderProps) {
  const HeadingTag = `h${headingLevel}` as const;

  return (
    <header {...rest} className={cx("sr-page-header", className)}>
      <div className="sr-page-header__content">
        {icon ? (
          <span className="sr-page-header__icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <div className="sr-page-header__copy">
          {eyebrow ? (
            <p className="sr-page-header__eyebrow">{eyebrow}</p>
          ) : null}
          <HeadingTag className="sr-page-header__title">{title}</HeadingTag>
          {description ? (
            <div className="sr-page-header__description">{description}</div>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="sr-page-header__actions">{actions}</div>
      ) : null}
    </header>
  );
}
