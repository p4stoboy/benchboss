// Avalon published mission/team-size + fail-threshold tables (op index 0..4).
export const MISSION_TEAM_SIZES: Record<number, number[]> = {
  5: [2, 3, 2, 3, 3],
  7: [2, 3, 3, 4, 4],
  9: [3, 4, 4, 5, 5],
};

export const MISSION_FAIL_THRESHOLDS: Record<number, number[]> = {
  5: [1, 1, 1, 1, 1],
  7: [1, 1, 1, 2, 1],
  9: [1, 1, 1, 2, 1],
};

export function teamSize(seats: number, opIndex: number): number {
  const row = MISSION_TEAM_SIZES[seats];
  if (row === undefined) throw new Error(`no mission table for ${seats} seats`);
  const size = row[opIndex];
  if (size === undefined) throw new Error(`op index ${opIndex} out of range for ${seats} seats`);
  return size;
}

// Team size of the operation at `opIndex`, or 0 once the table is exhausted: after the
// fifth op the match is terminal (or in assassinate) and there is no next team.
export function nextTeamSize(seats: number, opIndex: number): number {
  return MISSION_TEAM_SIZES[seats]?.[opIndex] ?? 0;
}

export function failThreshold(seats: number, opIndex: number): number {
  const row = MISSION_FAIL_THRESHOLDS[seats];
  if (row === undefined) throw new Error(`no fail table for ${seats} seats`);
  const threshold = row[opIndex];
  if (threshold === undefined)
    throw new Error(`op index ${opIndex} out of range for ${seats} seats`);
  return threshold;
}
