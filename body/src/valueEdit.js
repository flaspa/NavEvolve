/**
 * valueEdit.js — validation for manually typed calibration values.
 *
 * Calibration sliders can be edited numerically so an exact figure (0.42,
 * 0.065, 1.125) can be dialled in without hunting with the mouse. Typed input
 * is validated here, separately from any DOM, so the rules are testable.
 *
 * Deliberately strict: an out-of-range value is REJECTED, never clamped.
 * Silently clamping would apply a calibration the user did not ask for, which
 * is exactly the sort of quiet mismatch that is expensive to debug later.
 */

/**
 * Validates a typed calibration value against a slider's own limits.
 *
 * The slider's `step` is treated as a UI convenience, not a constraint: any
 * finite value inside [min, max] is accepted exactly, so typed precision
 * survives even when the thumb can only land on coarser increments.
 *
 * @param {string|number} raw   what the user typed
 * @param {object} bounds       { min, max } from the slider
 * @returns {{ok: true, value: number} | {ok: false, reason: string}}
 */
export function parseNumericEdit(raw, { min, max } = {}) {
  const text = typeof raw === "number" ? String(raw) : String(raw ?? "").trim();

  if (text === "") return { ok: false, reason: "empty" };

  // Number("") is 0 and Number(" ") is 0, hence the empty check above.
  // Number("Infinity") is Infinity, which isFinite rejects.
  const value = Number(text);

  if (!Number.isFinite(value)) return { ok: false, reason: "not-a-number" };

  if (Number.isFinite(min) && value < min) {
    return { ok: false, reason: "below-min" };
  }
  if (Number.isFinite(max) && value > max) {
    return { ok: false, reason: "above-max" };
  }

  return { ok: true, value };
}
