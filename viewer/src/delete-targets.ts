export type Filling = { opening: number; filling: number };

/** Openings left empty once `targets` are gone. An opening that keeps another filling stays. */
export function openingsFreedBy(fillings: Filling[], targets: ReadonlySet<number>): number[] {
  const byOpening = new Map<number, number[]>();
  for (const { opening, filling } of fillings) byOpening.set(opening, [...(byOpening.get(opening) ?? []), filling]);
  return [...byOpening].filter(([, filled]) => filled.some((id) => targets.has(id)) && filled.every((id) => targets.has(id)))
    .map(([opening]) => opening);
}
