/** Length conversions for wizard display; Kiri import always uses mm internally. */

import type { DisplayUnits } from "./presets/types";

export const MM_PER_INCH = 25.4;

export function mmToInches(mm: number): number {
  return mm / MM_PER_INCH;
}

export function inchesToMm(inches: number): number {
  return inches * MM_PER_INCH;
}

/** Value shown in number inputs (avoids excessive float noise). */
export function lengthToDisplay(mm: number, units: DisplayUnits): number {
  if (units === "mm") return Math.round(mm * 1000) / 1000;
  return Math.round(mmToInches(mm) * 10000) / 10000;
}

/** Parse user input in current display units → millimeters. */
export function lengthFromDisplay(value: number, units: DisplayUnits): number {
  if (!Number.isFinite(value)) return 0;
  return units === "mm" ? value : inchesToMm(value);
}
