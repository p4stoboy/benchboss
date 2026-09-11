// Frozen protocol v1 / game revision 1.0.0. Preserve for historical replay.
import type { Rng, SeatId } from "@benchboss/core";
import type { Alignment, Role, RoleDeal } from "./types";

export const SPY_ROLE_TABLE: Record<number, { loyal: number; mole: number }> = {
  5: { loyal: 3, mole: 2 },
  7: { loyal: 4, mole: 3 },
  9: { loyal: 6, mole: 3 },
};

export function dealRoles(seats: SeatId[], rng: Rng): RoleDeal {
  const counts = SPY_ROLE_TABLE[seats.length];
  if (!counts) throw new Error(`no role table for ${seats.length} seats`);

  const bag: Alignment[] = [
    ...Array<Alignment>(counts.loyal).fill("loyal"),
    ...Array<Alignment>(counts.mole).fill("mole"),
  ];

  const rolesRng = rng.fork("roles");
  rolesRng.shuffle(bag);

  const roleBySeat: Record<SeatId, Role> = {} as Record<SeatId, Role>;
  const alignmentBySeat: Record<SeatId, Alignment> = {} as Record<SeatId, Alignment>;
  const moleSeats: SeatId[] = [];

  for (let i = 0; i < seats.length; i++) {
    const seat = seats[i] as SeatId;
    const align = bag[i] as Alignment;
    alignmentBySeat[seat] = align;
    roleBySeat[seat] = align; // M2: base roles only; M3 specialises handler/deepcover.
    if (align === "mole") moleSeats.push(seat);
  }

  // Mutual knowledge: Moles see all mole seats (incl. self); Loyals see nothing.
  const knownMolesBySeat: Record<SeatId, SeatId[]> = {} as Record<SeatId, SeatId[]>;
  for (const seat of seats) {
    knownMolesBySeat[seat] = alignmentBySeat[seat] === "mole" ? [...moleSeats] : [];
  }

  return {
    roleBySeat,
    alignmentBySeat,
    moleSeats,
    knownMolesBySeat,
    handlerSeat: null,
    deepCoverSeat: null,
  };
}

export function dealRolesM3(seats: SeatId[], rng: Rng): RoleDeal {
  const base = dealRoles(seats, rng);
  const promoteRng = rng.fork("specialize");
  const loyals = seats.filter((s) => base.alignmentBySeat[s] === "loyal");
  const handlerSeat = promoteRng.pick(loyals);
  const deepCoverSeat = promoteRng.pick(base.moleSeats);
  const roleBySeat = { ...base.roleBySeat };
  roleBySeat[handlerSeat] = "handler";
  roleBySeat[deepCoverSeat] = "deepcover";

  // Update knownMolesBySeat: Handler sees moles minus Deep Cover; Deep Cover is still seen by fellow moles.
  const knownMolesBySeat = { ...base.knownMolesBySeat };
  knownMolesBySeat[handlerSeat] = base.moleSeats.filter((s) => s !== deepCoverSeat);

  return { ...base, roleBySeat, handlerSeat, deepCoverSeat, knownMolesBySeat };
}
