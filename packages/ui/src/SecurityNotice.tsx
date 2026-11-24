import { type HTMLAttributes, type ReactNode, useId } from "react";

import { cx } from "./cx.js";

export type SecurityNoticeTone = "info" | "brand" | "neutral";

export interface SecurityNoticeItem {
  id?: string;
  icon?: ReactNode;
  text: ReactNode;
}

export interface SecurityNoticeProps extends HTMLAttributes<HTMLElement> {
  title?: string;
  headingLevel?: 2 | 3 | 4;
  label?: string;
  tone?: SecurityNoticeTone;
  items?: readonly SecurityNoticeItem[];
  children?: ReactNode;
}

export function SecurityNotice({
  title,
  headingLevel = 2,
  label,
  tone = "info",
  items,
  children,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...rest
}: SecurityNoticeProps) {
  const generatedTitleId = useId();
  const titleId = title ? generatedTitleId : undefined;
  const resolvedLabelledBy = ariaLabelledBy ?? titleId;
  const resolvedAriaLabel = resolvedLabelledBy
    ? undefined
    : (ariaLabel ?? label);

  const HeadingTag = `h${headingLevel}` as const;

  return (
    <section
      {...rest}
      className={cx(
        "sr-security-notice",
        `sr-security-notice--${tone}`,
        className,
      )}
      {...(resolvedLabelledBy ? { "aria-labelledby": resolvedLabelledBy } : {})}
      {...(resolvedAriaLabel ? { "aria-label": resolvedAriaLabel } : {})}
    >
      {title ? (
        <HeadingTag id={titleId} className="sr-security-notice__title">
          {title}
        </HeadingTag>
      ) : null}

      {items && items.length > 0 ? (
        <ul className="sr-security-notice__list">
          {items.map((item, index) => (
            <li key={item.id ?? index} className="sr-security-notice__item">
              {item.icon ? (
                <span className="sr-security-notice__icon" aria-hidden="true">
                  {item.icon}
                </span>
              ) : null}
              <span className="sr-security-notice__text">{item.text}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {children}
    </section>
  );
}
