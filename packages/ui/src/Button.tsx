import type { ComponentPropsWithRef, MouseEvent, ReactNode } from "react";

import { cx } from "./cx.js";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "md" | "lg";

interface ButtonCommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  children: ReactNode;
}

export type NativeButtonProps = ButtonCommonProps &
  Omit<ComponentPropsWithRef<"button">, keyof ButtonCommonProps> & {
    href?: undefined;
  };

export type LinkButtonProps = ButtonCommonProps &
  Omit<ComponentPropsWithRef<"a">, keyof ButtonCommonProps> & {
    href: string;
  };

export type ButtonProps = NativeButtonProps | LinkButtonProps;

function renderButtonContent({
  children,
  leadingIcon,
  trailingIcon,
  loading,
  loadingLabel,
}: Pick<
  ButtonCommonProps,
  "children" | "leadingIcon" | "trailingIcon" | "loading" | "loadingLabel"
>) {
  return (
    <>
      {loading ? (
        <span className="sr-button__spinner" aria-hidden="true" />
      ) : leadingIcon ? (
        <span className="sr-button__icon" aria-hidden="true">
          {leadingIcon}
        </span>
      ) : null}
      <span className="sr-button__label">
        {loading && loadingLabel ? loadingLabel : children}
      </span>
      {loading && !loadingLabel ? (
        <>
          {" "}
          <span className="sr-only">(carregando)</span>
        </>
      ) : null}
      {!loading && trailingIcon ? (
        <span className="sr-button__icon" aria-hidden="true">
          {trailingIcon}
        </span>
      ) : null}
    </>
  );
}

export function Button(props: ButtonProps) {
  const variant = props.variant ?? "primary";
  const size = props.size ?? "md";
  const fullWidth = props.fullWidth ?? false;
  const loading = props.loading ?? false;
  const isDisabled = Boolean(props.disabled || loading);

  const classes = cx(
    "sr-button",
    `sr-button--${variant}`,
    `sr-button--${size}`,
    fullWidth && "sr-button--full-width",
    props.className,
  );

  const content = renderButtonContent({
    children: props.children,
    leadingIcon: props.leadingIcon,
    trailingIcon: props.trailingIcon,
    loading,
    ...(props.loadingLabel !== undefined
      ? { loadingLabel: props.loadingLabel }
      : {}),
  });

  if (typeof props.href === "string") {
    const {
      href,
      variant: _variant,
      size: _size,
      fullWidth: _fullWidth,
      disabled: _disabled,
      loading: _loading,
      loadingLabel: _loadingLabel,
      leadingIcon: _leadingIcon,
      trailingIcon: _trailingIcon,
      className: _className,
      children: _children,
      onClick,
      ...anchorRest
    } = props;

    const handleAnchorClick = (event: MouseEvent<HTMLAnchorElement>) => {
      if (isDisabled) {
        event.preventDefault();
        return;
      }
      onClick?.(event);
    };

    return (
      <a
        {...anchorRest}
        {...(isDisabled ? { role: "link" } : { href })}
        className={classes}
        {...(isDisabled ? { "aria-disabled": true as const } : {})}
        {...(loading
          ? { "aria-busy": true as const, "data-loading": "true" }
          : {})}
        onClick={handleAnchorClick}
      >
        {content}
      </a>
    );
  }

  const {
    href: _href,
    variant: _variant,
    size: _size,
    fullWidth: _fullWidth,
    disabled: _disabled,
    loading: _loading,
    loadingLabel: _loadingLabel,
    leadingIcon: _leadingIcon,
    trailingIcon: _trailingIcon,
    className: _className,
    children: _children,
    type = "button",
    onClick,
    ...buttonRest
  } = props;

  const handleButtonClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  return (
    <button
      {...buttonRest}
      type={type}
      className={classes}
      disabled={isDisabled}
      {...(loading
        ? { "aria-busy": true as const, "data-loading": "true" }
        : {})}
      onClick={handleButtonClick}
    >
      {content}
    </button>
  );
}
