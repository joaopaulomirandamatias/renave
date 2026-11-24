import type { HTMLAttributes } from "react";

import { cx } from "./cx.js";

export type RenaveStockState =
  "SOLICITADO" | "TRANSFERIDO" | "CONFIRMADO" | "FINALIZADO";

export const RENAVE_STOCK_STATE_LABELS: Readonly<
  Record<RenaveStockState, string>
> = Object.freeze({
  SOLICITADO: "Entrada solicitada · aguardando transferência",
  TRANSFERIDO: "Propriedade transferida · aguardando novo CRV",
  CONFIRMADO: "Em estoque",
  FINALIZADO: "Baixado",
});

const TONES: Readonly<Record<RenaveStockState, string>> = Object.freeze({
  SOLICITADO: "info",
  TRANSFERIDO: "warning",
  CONFIRMADO: "success",
  FINALIZADO: "neutral",
});

export interface StockStateBadgeProps extends Omit<
  HTMLAttributes<HTMLSpanElement>,
  "children"
> {
  state: RenaveStockState;
}

export function StockStateBadge({
  state,
  className,
  role = "status",
  ...rest
}: StockStateBadgeProps) {
  return (
    <span
      {...rest}
      role={role}
      data-stock-state={state}
      className={cx(
        "sr-stock-state",
        `sr-stock-state--${TONES[state]}`,
        className,
      )}
    >
      {RENAVE_STOCK_STATE_LABELS[state]}
    </span>
  );
}
