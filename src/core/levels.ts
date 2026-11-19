import type { Feature } from "../protocol";

/**
 * Worsley's levels, for a course that brings its help in a little at a
 * time. Each level offers what the one before it does, and more. The first
 * offers only requests that stand alone and teach how the language is
 * written: explaining one line on its own, and translating pseudocode into
 * code without adding to it. The last offers everything.
 */

export interface Level {
  /** What the setting calls it. */
  name: string;
  /** What this level adds to the one before it. */
  adds: readonly Feature[];
}

export const LEVELS: readonly Level[] = [
  { name: "Syntax", adds: ["explain", "translate"] },
  { name: "Everything", adds: ["ask", "change", "tour", "review"] },
];

/** The highest level, which offers everything; Worsley's level unless a setting says otherwise. */
export const TOP_LEVEL = LEVELS.length;

/** A level that exists: whole, and from 1 to the top. */
export function clampLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(TOP_LEVEL, Math.max(1, Math.floor(level))) : TOP_LEVEL;
}

/** What `level` offers: what it adds, and what every level below it does. */
export function featuresAt(level: number): ReadonlySet<Feature> {
  return new Set(LEVELS.slice(0, clampLevel(level)).flatMap((l) => l.adds));
}

const FEATURE_NAMES: Record<Feature, string> = {
  explain: "explaining a line",
  translate: "translating pseudocode",
  ask: "asking about the code",
  change: "changing the code",
  tour: "tours",
  review: "reviewing your changes",
};

/** Why a request wasn't made: the feature it needs isn't part of `level`. */
export function notAtLevel(feature: Feature, level: number): string {
  return `Worsley is at level ${clampLevel(level)}, which doesn't include ${FEATURE_NAMES[feature]}.`;
}
