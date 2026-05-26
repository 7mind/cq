/**
 * CountdownRing.tsx — SVG ring component for the connection-status countdown.
 *
 * Purely visual: no timers, no side effects. The caller supplies `remaining`
 * and `total` (both in milliseconds, or any consistent unit). The ring
 * stroke-dashoffset depletes from empty (full ring visible) to full
 * (ring consumed = deadline reached):
 *
 *   remaining = total  → dashoffset = 0    (full ring shown — deadline far away)
 *   remaining = 0      → dashoffset = circ (ring fully consumed — at deadline)
 *
 * The ring is rendered as an SVG circle centered in a square viewport.
 * It overlays the colored dot produced by <Indicator>.
 *
 * PR-14: countdown ring [ws P3-i-4].
 */

import type React from "react";

export interface CountdownRingProps {
  /** Remaining time (ms). Clamped to [0, total]. */
  remaining: number;
  /** Total duration (ms). Must be > 0. */
  total: number;
  /** Side length of the square SVG viewport in pixels. Default: 32. */
  size?: number;
  /** Stroke width in pixels. Default: 3. */
  strokeWidth?: number;
  /** When true, aria-hidden is set on the SVG. Default: true. */
  ariaHidden?: boolean;
}

/**
 * SVG ring whose visible arc length represents `remaining / total`.
 *
 * At `remaining === total` the ring shows fully (stroke-dashoffset = 0).
 * At `remaining === 0` the ring is fully consumed (dashoffset = circumference).
 */
export function CountdownRing({
  remaining,
  total,
  size = 32,
  strokeWidth = 3,
  ariaHidden = true,
}: CountdownRingProps): React.ReactElement {
  const clampedRemaining = Math.max(0, Math.min(remaining, total));
  const fraction = total > 0 ? clampedRemaining / total : 0;

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  // dashoffset = 0      → full ring (remaining = total)
  // dashoffset = circ   → empty ring (remaining = 0)
  const dashOffset = circumference * (1 - fraction);

  const center = size / 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden={ariaHidden ? "true" : undefined}
      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
    >
      {/* Track: faint full circle */}
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth={strokeWidth}
      />
      {/* Indicator arc: depletes clockwise */}
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.85)"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        // Start at top (12 o'clock) — rotate -90°
        transform={`rotate(-90 ${center} ${center})`}
      />
    </svg>
  );
}
