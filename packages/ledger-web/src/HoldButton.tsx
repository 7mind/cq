/**
 * HoldButton — a reusable confirm-by-holding button (web only).
 *
 * Per Q81/Q82. A destructive/confirming action is gated behind a deliberate
 * press-and-hold gesture rather than a single click: the user must keep the
 * pointer (or Enter/Space key) pressed for {@link HOLD_MS} for `onConfirm` to
 * fire. A visible progress bar fills over the hold so the affordance is
 * legible, and the gesture is identical across the pointer and keyboard
 * modalities. Releasing the pointer, moving it off the button, or releasing
 * the key before the threshold cancels and resets the bar — the action does
 * NOT fire.
 *
 * `requireHold={false}` degrades to an ordinary single-click button (the
 * escape hatch for callers that do not want the hold gesture).
 *
 * Timing is driven through an injectable {@link HoldClock} so the component is
 * deterministically drivable from the happy-dom test harness: tests pass a
 * fake clock they advance synchronously. Production uses the real
 * `setTimeout`/`clearTimeout` + `performance.now()` default.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";

/** Hold duration, in milliseconds, before `onConfirm` fires. */
export const HOLD_MS = 1000;

/**
 * Progress-bar refresh cadence, in milliseconds. The bar is repainted on this
 * interval while a hold is in progress; the tick at/after {@link HOLD_MS} also
 * fires the confirm.
 */
export const PROGRESS_TICK_MS = 50;

/**
 * Minimal timer surface the component depends on. Defaults to the real browser
 * clock; tests inject a controllable fake so holds advance deterministically.
 */
export interface HoldClock {
  setTimeout: (cb: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  now: () => number;
}

const realClock: HoldClock = {
  setTimeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
  now: () => performance.now(),
};

export interface HoldButtonProps {
  /** Fired once when a hold completes (or, with requireHold=false, on click). */
  onConfirm: () => void;
  /** Button label / contents. */
  children: React.ReactNode;
  /** When false, behave as an ordinary single-click button. Default true. */
  requireHold?: boolean;
  /** Standard disabled passthrough. */
  disabled?: boolean;
  /** Injected clock (tests only); defaults to the real browser clock. */
  clock?: HoldClock | undefined;
  /** Optional class for the outer button. */
  className?: string;
  /** Optional test id. */
  "data-testid"?: string;
}

export function HoldButton({
  onConfirm,
  children,
  requireHold = true,
  disabled = false,
  clock = realClock,
  className,
  "data-testid": testId,
}: HoldButtonProps): React.ReactElement {
  // Fraction in [0, 1] of the hold completed; drives the visible bar width.
  const [progress, setProgress] = useState(0);

  // Mutable hold state kept in refs so timer callbacks see live values
  // without restarting effects.
  const startedAtRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  // Guard so a completed hold fires onConfirm exactly once.
  const firedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clock.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [clock]);

  const reset = useCallback(() => {
    clearTimer();
    startedAtRef.current = null;
    firedRef.current = false;
    setProgress(0);
  }, [clearTimer]);

  // One scheduled tick: recompute elapsed, update the bar, fire on completion.
  const tick = useCallback(() => {
    const startedAt = startedAtRef.current;
    if (startedAt === null) return;
    const elapsed = clock.now() - startedAt;
    const fraction = Math.min(elapsed / HOLD_MS, 1);
    setProgress(fraction);
    if (elapsed >= HOLD_MS) {
      if (!firedRef.current) {
        firedRef.current = true;
        clearTimer();
        startedAtRef.current = null;
        setProgress(0);
        onConfirm();
      }
      return;
    }
    timerRef.current = clock.setTimeout(tick, PROGRESS_TICK_MS);
  }, [clock, clearTimer, onConfirm]);

  const startHold = useCallback(() => {
    if (disabled) return;
    // Ignore re-arm while a hold is already running (e.g. key auto-repeat).
    if (startedAtRef.current !== null) return;
    firedRef.current = false;
    startedAtRef.current = clock.now();
    setProgress(0);
    timerRef.current = clock.setTimeout(tick, PROGRESS_TICK_MS);
  }, [disabled, clock, tick]);

  // Cancel and reset an in-flight hold (release before the threshold).
  const cancelHold = useCallback(() => {
    if (startedAtRef.current === null) return;
    reset();
  }, [reset]);

  // Tear down any pending timer on unmount.
  useEffect(() => () => clearTimer(), [clearTimer]);

  // --- single-click escape hatch -------------------------------------------
  if (!requireHold) {
    return (
      <button
        type="button"
        className={className}
        data-testid={testId}
        disabled={disabled}
        onClick={() => {
          if (!disabled) onConfirm();
        }}
      >
        {children}
      </button>
    );
  }

  // --- hold gesture --------------------------------------------------------
  const isHoldKey = (key: string): boolean => key === "Enter" || key === " " || key === "Spacebar";

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (isHoldKey(e.key)) {
      // Suppress the synthetic click the browser emits for Enter/Space on a
      // button so the hold gesture is the sole confirm path.
      e.preventDefault();
      startHold();
    }
  };

  const onKeyUp = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (isHoldKey(e.key)) {
      e.preventDefault();
      cancelHold();
    }
  };

  const pct = Math.round(progress * 100);

  return (
    <button
      type="button"
      className={["lw-holdbtn", className].filter(Boolean).join(" ")}
      data-testid={testId}
      disabled={disabled}
      onPointerDown={(e) => {
        e.preventDefault();
        startHold();
      }}
      onPointerUp={cancelHold}
      onPointerOut={cancelHold}
      onPointerCancel={cancelHold}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
    >
      <span className="lw-holdbtn-label">{children}</span>
      <span
        className="lw-holdbtn-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        data-testid={testId !== undefined ? `${testId}-progress` : undefined}
      >
        <span className="lw-holdbtn-fill" style={{ width: `${pct}%` }} />
      </span>
    </button>
  );
}
