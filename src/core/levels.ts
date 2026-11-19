import type { Feature } from "../protocol";

/**
 * Worsley's levels, for a course that brings its help in a little at a
 * time. Each level offers what the one before it does, and more. Level 1
 * teaches how code is written: explaining one line on its own, and
 * translating pseudocode into code without adding to it. Level 2 works on
 * whole functions: checking one against its documentation and tests, and
 * writing a body from them. Level N, the last, offers everything else, and
 * leaves room for numbered levels before it as a course needs them.
 */

/** A level as the setting names it: a numbered one, or "N", the last. */
export type LevelName = number | "N";

export interface Level {
  /** What the setting calls it. */
  name: string;
  /** What this level adds to the one before it. */
  adds: readonly Feature[];
}

/** The numbered levels, level 1 first. */
export const NUMBERED: readonly Level[] = [
  { name: "Syntax", adds: ["explain", "translate"] },
  { name: "Functions", adds: ["check", "fill"] },
];

/** Level N: everything that no numbered level offers yet. */
export const LEVEL_N: Level = { name: "Everything", adds: ["ask", "change", "tour", "review"] };

/**
 * The level a setting's value names. A number is a numbered level, the
 * nearest that exists, so that 3 is level 2 until there is a level 3. "N",
 * and anything else, is level N, which is also the default.
 */
export function levelOf(value: unknown): LevelName {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? Math.min(NUMBERED.length, Math.max(1, Math.floor(n))) : "N";
}

/** What `level` offers: what it adds, and what every level below it does. */
export function featuresAt(level: LevelName): ReadonlySet<Feature> {
  const levels = level === "N" ? [...NUMBERED, LEVEL_N] : NUMBERED.slice(0, level);
  return new Set(levels.flatMap((l) => l.adds));
}

/** Every feature, as level N offers them. */
export const ALL_FEATURES: ReadonlySet<Feature> = featuresAt("N");

const FEATURE_NAMES: Record<Feature, string> = {
  explain: "explaining a line",
  translate: "translating pseudocode",
  check: "checking a function against its documentation and tests",
  fill: "filling in a function",
  ask: "asking about the code",
  change: "changing the code",
  tour: "tours",
  review: "reviewing your changes",
};

/** Why a request wasn't made: the feature it needs isn't part of `level`. */
export function notAtLevel(feature: Feature, level: LevelName): string {
  return `Worsley is at level ${level}, which doesn't include ${FEATURE_NAMES[feature]}.`;
}
