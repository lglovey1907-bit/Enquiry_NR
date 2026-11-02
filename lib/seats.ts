export type Stop = { code: string; name: string; hi?: string; seats: Record<string, number> | null };

/** Delhi-area stations: never shown as destinations (no current-booking need for such short trips). */
export const LOCAL = new Set(["NZM", "DLI", "DSA", "DEC", "DEE", "DKZ", "DSJ", "ANVT", "SSB", "SBB", "GZB", "FDB", "FDN", "BVH",
                              "GGN", "OKA", "TKD", "NNO", "ADRS", "NUR", "NDLS"]);

/** Keep only destinations outside Delhi with at least one class that has current-booking seats, and only those classes. */
export const availableOnly = <S extends Stop>(stops: S[], local: Set<string> = LOCAL): S[] =>
  (stops ?? []).filter(s => !local.has(s.code)).flatMap(s => {
    const seats = Object.fromEntries(Object.entries(s.seats ?? {}).filter(([, n]) => Number(n) > 0));
    return Object.keys(seats).length ? [{ ...s, seats }] : [];
  });

/** Usual coach order, highest class first; anything else follows alphabetically. */
const CLASS_ORDER = ["1A", "EA", "EC", "FC", "2A", "3A", "3E", "CC", "EV", "VS", "SL", "2S"];
export const sortClasses = (cs: string[]) =>
  [...cs].sort((a, b) => {
    const ia = CLASS_ORDER.indexOf(a), ib = CLASS_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
