/** The main roads of a route: named roads by total length, longest first, at most `max`. */
export function mainRoads(roads: ReadonlyArray<{ name: string; distance: number }>, max = 5): string[] {
  const totals = new Map<string, number>();
  for (const { name, distance } of roads) {
    const key = name.trim();
    if (key) totals.set(key, (totals.get(key) ?? 0) + distance);
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([name]) => name);
}
