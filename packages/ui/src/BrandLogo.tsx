import { cx } from "./cx.js";

export interface BrandLogoProps {
  compact?: boolean;
  label?: string;
  showWordmark?: boolean;
  variant?: "default" | "inverse";
  className?: string;
}

export function BrandLogo({
  compact = false,
  label = "RenavEstoque",
  showWordmark,
  variant = "default",
  className,
}: BrandLogoProps) {
  const displayWordmark = showWordmark ?? !compact;
  const inverse = variant === "inverse";

  return (
    <div
      className={cx(
        "sr-brand",
        compact && "sr-brand--compact",
        inverse && "sr-brand--inverse",
        className,
      )}
      role="img"
      aria-label={label}
    >
      {compact ? (
        <svg width={32} height={32} viewBox="0 0 32 32" aria-hidden="true">
          <path
            d="M8 3.5h10.5l6 6V26a2.5 2.5 0 0 1-2.5 2.5H8A2.5 2.5 0 0 1 5.5 26V6A2.5 2.5 0 0 1 8 3.5z"
            fill={inverse ? "#0B2550" : "#FFFFFF"}
            stroke={inverse ? "#FFFFFF" : "#0B2550"}
            strokeWidth="2.6"
            strokeLinejoin="round"
          />
          <path
            d="M18.5 3.5v6h6z"
            fill="#0A9B55"
            stroke="#0A9B55"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <circle
            cx="24.5"
            cy="17"
            r="6"
            fill="#0A9B55"
            stroke={inverse ? "#0B2550" : "#FFFFFF"}
            strokeWidth="1.6"
          />
          <path
            d="M21.8 17.1l1.9 1.9 3.5-3.7"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width={76} height={76} viewBox="0 0 120 120" aria-hidden="true">
          <path
            d="M4 112 C34 96 72 110 116 92"
            fill="none"
            stroke="#F2A90C"
            strokeWidth="16"
            strokeLinecap="round"
          />
          <path
            d="M4 110 C34 94 72 108 116 90"
            fill="none"
            stroke="#0A9B55"
            strokeWidth="13"
            strokeLinecap="round"
          />
          <path
            d="M4 110 C34 94 72 108 116 90"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="2"
            strokeDasharray="6 5"
          />
          <path
            d="M30 8h38l20 20v58a8 8 0 0 1-8 8H30a8 8 0 0 1-8-8V16a8 8 0 0 1 8-8z"
            fill="#FFFFFF"
            stroke="#0B2550"
            strokeWidth="7"
            strokeLinejoin="round"
          />
          <path
            d="M68 8v20h20z"
            fill="#0A9B55"
            stroke="#0A9B55"
            strokeWidth="4"
            strokeLinejoin="round"
          />
          <rect x="34" y="26" width="28" height="7" rx="3.5" fill="#0B2550" />
          <rect x="34" y="39" width="20" height="7" rx="3.5" fill="#0B2550" />
          <path
            d="M32 66 39 52h32l7 14h10a8 8 0 0 1 8 8v14a4 4 0 0 1-4 4h-6v5a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3v-5H37v5a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3v-5h-6a4 4 0 0 1-4-4V74a8 8 0 0 1 8-8z"
            fill="#0B2550"
          />
          <path
            d="M42 56 H68 L73 64 H37 Z"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          <rect x="19" y="73" width="12" height="6" rx="3" fill="#FFFFFF" />
          <rect x="79" y="73" width="12" height="6" rx="3" fill="#FFFFFF" />
          <circle
            cx="88"
            cy="45"
            r="15"
            fill="#0A9B55"
            stroke="#FFFFFF"
            strokeWidth="4"
          />
          <path
            d="m80.5 45.5 5 5 9.5-10"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {displayWordmark && (
        <span className="sr-brand__name">
          <span>Renav</span>
          <strong>Estoque</strong>
        </span>
      )}
    </div>
  );
}
