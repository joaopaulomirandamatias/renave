import { cx } from "./cx.js";

export interface BrandLogoProps {
  compact?: boolean;
  label?: string;
  className?: string;
}

export function BrandLogo({
  compact = false,
  label = "Seu Renave",
  className,
}: BrandLogoProps) {
  const size = compact ? 44 : 68;
  return (
    <div className={cx("sr-brand", className)} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox="0 0 120 120" aria-hidden="true">
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
          stroke="#FFF"
          strokeWidth="2"
          strokeDasharray="6 5"
        />
        <path
          d="M30 8h38l20 20v58a8 8 0 0 1-8 8H30a8 8 0 0 1-8-8V16a8 8 0 0 1 8-8z"
          fill="#FFF"
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
        <circle
          cx="88"
          cy="45"
          r="15"
          fill="#0A9B55"
          stroke="#FFF"
          strokeWidth="4"
        />
        <path
          d="m80.5 45.5 5 5 9.5-10"
          fill="none"
          stroke="#FFF"
          strokeWidth="5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {!compact && (
        <span className="sr-brand__name">
          <span>Seu</span> <strong>Renave</strong>
        </span>
      )}
    </div>
  );
}
