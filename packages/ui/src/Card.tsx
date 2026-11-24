import type { HTMLAttributes, ReactNode } from "react";

import type { HeadingLevel } from "./PageHeader.js";
import { cx } from "./cx.js";

export type CardElement = "article" | "section" | "div";
export type CardPadding = "none" | "md" | "lg";
export type CardVariant = "default" | "subtle";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  as?: CardElement;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  headingLevel?: HeadingLevel;
  padding?: CardPadding;
  variant?: CardVariant;
  children?: ReactNode;
}

export function Card({
  as: CardTag = "article",
  title,
  description,
  actions,
  headingLevel = 2,
  padding = "md",
  variant = "default",
  children,
  className,
  ...rest
}: CardProps) {
  const HeadingTag = `h${headingLevel}` as const;
  const hasHeader = title !== undefined || description !== undefined || actions;

  return (
    <CardTag
      {...rest}
      className={cx(
        "sr-card",
        `sr-card--${variant}`,
        `sr-card--padding-${padding}`,
        className,
      )}
    >
      {hasHeader ? (
        <header className="sr-card__header">
          <div className="sr-card__heading">
            {title !== undefined ? (
              <HeadingTag className="sr-card__title">{title}</HeadingTag>
            ) : null}
            {description !== undefined ? (
              <div className="sr-card__description">{description}</div>
            ) : null}
          </div>
          {actions ? <div className="sr-card__actions">{actions}</div> : null}
        </header>
      ) : null}
      {children !== undefined ? (
        <div className="sr-card__body">{children}</div>
      ) : null}
    </CardTag>
  );
}
