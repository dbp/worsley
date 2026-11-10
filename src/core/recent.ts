/** A model on a backend, as the backend picker offers it again. */
export interface ModelChoice {
  backend: string;
  model: string;
}

/** How many choices the picker offers again. */
export const RECENT_CHOICES = 6;

/** `chosen` first, then the rest of `recent` without it, at most RECENT_CHOICES in all. */
export function remember(recent: readonly ModelChoice[], chosen: ModelChoice): ModelChoice[] {
  const other = (c: ModelChoice): boolean => c.backend !== chosen.backend || c.model !== chosen.model;
  return [chosen, ...recent.filter(other)].slice(0, RECENT_CHOICES);
}
