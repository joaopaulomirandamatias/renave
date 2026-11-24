import type { HTMLAttributes } from "react";

import { cx } from "./cx.js";

export const APP_ENVIRONMENT_LABELS = {
  development: "Desenvolvimento",
  homologation: "Homologação",
  production: "Produção",
} as const;

export type AppEnvironment = keyof typeof APP_ENVIRONMENT_LABELS;

export function resolveAppEnvironment(value?: string): AppEnvironment {
  const normalized = value?.trim().toLowerCase();
  if (normalized && normalized in APP_ENVIRONMENT_LABELS) {
    return normalized as AppEnvironment;
  }
  return "development";
}

export interface EnvironmentBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  environment: AppEnvironment;
  prefix?: string;
  showPrefix?: boolean;
}

export function EnvironmentBadge({
  environment,
  prefix = "Ambiente",
  showPrefix = true,
  className,
  role = "status",
  ...rest
}: EnvironmentBadgeProps) {
  const label = APP_ENVIRONMENT_LABELS[environment];

  return (
    <span
      {...rest}
      role={role}
      data-environment={environment}
      className={cx("sr-env-badge", `sr-env-badge--${environment}`, className)}
    >
      <span className="sr-env-badge__dot" aria-hidden="true" />
      <span>{showPrefix ? `${prefix}: ${label}` : label}</span>
    </span>
  );
}
