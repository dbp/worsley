import type { Feature, LevelSection } from "../protocol";

/**
 * Worsley's levels, for a course that brings its help in a little at a
 * time. Each level offers what the one before it does, and more. Level 1
 * teaches how code is written: explaining one line on its own, and
 * translating pseudocode into code without adding to it. Level 2 works on a
 * function or method and its spec, its documentation and tests: checking it
 * against them, and writing its body from them. Level 3 works on a change to a file: what else
 * in the program it calls for, so that a change to a design made in one
 * place can be finished everywhere. Level N, the last, offers everything
 * else, and leaves room for numbered levels before it as a course needs them.
 */

/** A level as the setting names it: a numbered one, or "N", the last. */
export type LevelName = number | "N";

export interface Level {
  /** What the setting and the panel call it. */
  name: string;
  /** What this level adds to the one before it. */
  adds: readonly Feature[];
}

/** The numbered levels, level 1 first. */
export const NUMBERED: readonly Level[] = [
  { name: "Syntax", adds: ["explain", "translate"] },
  { name: "Specs", adds: ["check", "fill"] },
  { name: "Changes", adds: ["reviewFile"] },
];

/** Level N: everything that no numbered level offers yet. */
export const LEVEL_N: Level = { name: "Everything", adds: ["ask", "change", "tour", "reviewAll"] };

/**
 * The level a setting's value names. A number is a numbered level, the
 * nearest that exists, so that 4 is level 3 until there is a level 4. "N",
 * and anything else, is level N, which is also the default.
 */
export function levelOf(value: unknown): LevelName {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? Math.min(NUMBERED.length, Math.max(1, Math.floor(n))) : "N";
}

/** The levels up to `level`, and it, each with what it adds: how the panel groups its buttons. */
export function sectionsAt(level: LevelName): LevelSection[] {
  const numbered = NUMBERED.slice(0, level === "N" ? NUMBERED.length : level).map((l, i) => ({ level: i + 1, name: l.name, features: [...l.adds] }));
  return level === "N" ? [...numbered, { level: "N", name: LEVEL_N.name, features: [...LEVEL_N.adds] }] : numbered;
}

/** What `level` offers: what it adds, and what every level below it does. */
export function featuresAt(level: LevelName): ReadonlySet<Feature> {
  return new Set(sectionsAt(level).flatMap((section) => section.features));
}

/** Every feature, as level N offers them. */
export const ALL_FEATURES: ReadonlySet<Feature> = featuresAt("N");

/** Every level, by number and name, for a choice among them. */
export const LEVEL_CHOICES: readonly Omit<LevelSection, "features">[] = sectionsAt("N").map(({ level, name }) => ({ level, name }));

const FEATURE_NAMES: Record<Feature, string> = {
  explain: "explaining a line",
  translate: "translating pseudocode",
  check: "checking a function or method against its documentation and tests",
  fill: "filling in a function or method",
  reviewFile: "reviewing your changes to a file",
  ask: "asking about the code",
  change: "changing the code",
  tour: "tours",
  reviewAll: "reviewing all your changes at once",
};

/** Why a request wasn't made: the feature it needs isn't part of `level`. */
export function notAtLevel(feature: Feature, level: LevelName): string {
  return `Worsley is at level ${level}, which doesn't include ${FEATURE_NAMES[feature]}.`;
}
