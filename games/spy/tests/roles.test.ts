import { describe, expect, test } from "bun:test";
import { createRng, mkSeatId } from "@benchboss/core";
import { SPY_ROLE_TABLE, dealRoles } from "../src/roles";

const seats5 = [0, 1, 2, 3, 4].map(mkSeatId);

describe("dealRoles", () => {
  test("deals_three_loyal_and_two_mole_at_five_seats", () => {
    const deal = dealRoles(seats5, createRng("seed-A"));
    const aligns = seats5.map((s) => deal.alignmentBySeat[s]);
    expect(aligns.filter((a) => a === "loyal").length).toBe(3);
    expect(aligns.filter((a) => a === "mole").length).toBe(2);
    expect(deal.moleSeats.length).toBe(2);
  });

  test("is_deterministic_for_the_same_seed", () => {
    const a = dealRoles(seats5, createRng("seed-A"));
    const b = dealRoles(seats5, createRng("seed-A"));
    expect(a.alignmentBySeat).toEqual(b.alignmentBySeat);
    expect(a.moleSeats).toEqual(b.moleSeats);
  });

  test("differs_across_seeds", () => {
    const a = dealRoles(seats5, createRng("seed-A"));
    const b = dealRoles(seats5, createRng("seed-Z"));
    // Over the role-permutation space these two seeds must not collide.
    expect(a.alignmentBySeat).not.toEqual(b.alignmentBySeat);
  });

  test("role_table_lists_avalon_counts", () => {
    expect(SPY_ROLE_TABLE[5]).toEqual({ loyal: 3, mole: 2 });
  });

  test("moles_know_each_other_loyals_know_nothing", () => {
    const deal = dealRoles(seats5, createRng("seed-A"));
    const moles = deal.moleSeats;
    expect(moles.length).toBe(2);

    const mole0 = moles[0];
    const mole1 = moles[1];
    expect(mole0).toBeDefined();
    expect(mole1).toBeDefined();

    // Each mole knows the other moles
    const mole0Known = deal.knownMolesBySeat[mole0 as NonNullable<typeof mole0>];
    const mole1Known = deal.knownMolesBySeat[mole1 as NonNullable<typeof mole1>];
    expect(mole0Known).toBeDefined();
    expect(mole1Known).toBeDefined();
    expect(mole0Known).toContain(mole1);
    expect(mole1Known).toContain(mole0);

    // Loyal seats have empty known sets
    const loyalSeats = seats5.filter((s) => deal.alignmentBySeat[s] === "loyal");
    for (const seat of loyalSeats) {
      const known = deal.knownMolesBySeat[seat];
      expect(known).toBeDefined();
      expect(known).toHaveLength(0);
    }
  });

  test("pin_concrete_seat_role_assignments_for_fixed_seed", () => {
    const deal = dealRoles(seats5, createRng("pin-seed-1"));
    // Hardcoded pin: if the shuffle/fork algorithm drifts these will fail.
    const s0 = mkSeatId(0);
    const s1 = mkSeatId(1);
    const s2 = mkSeatId(2);
    const s3 = mkSeatId(3);
    const s4 = mkSeatId(4);
    expect(deal.alignmentBySeat[s0]).toBeDefined();
    expect(deal.alignmentBySeat[s1]).toBeDefined();
    expect(deal.alignmentBySeat[s2]).toBeDefined();
    expect(deal.alignmentBySeat[s3]).toBeDefined();
    expect(deal.alignmentBySeat[s4]).toBeDefined();
    expect(deal.alignmentBySeat[s0]).toBe("mole");
    expect(deal.alignmentBySeat[s1]).toBe("mole");
    expect(deal.alignmentBySeat[s2]).toBe("loyal");
    expect(deal.alignmentBySeat[s3]).toBe("loyal");
    expect(deal.alignmentBySeat[s4]).toBe("loyal");
    expect(deal.moleSeats).toEqual([s0, s1]);
  });
});
