/** Seat-check intervals the database accepts. The worker runs every 15 minutes, so 15 is the shortest. */
export const INTERVALS = [15, 30, 45, 60, 90, 120] as const;
export type Interval = (typeof INTERVALS)[number];

export const intervalLabel = (m: number) =>
  m < 60 ? `${m} min` : m % 60 === 0 ? `${m / 60} hr` : `${Math.floor(m / 60)} hr ${m % 60} min`;
