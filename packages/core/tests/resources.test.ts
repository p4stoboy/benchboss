import { describe, expect, it } from "bun:test";
import * as core from "../src/index";

const seat = core.mkSeatId(0);
const otherSeat = core.mkSeatId(1);
const resources = {
  fuel: { amount: 4, reset: "match", visibility: "private" },
  messages: { amount: 3, reset: "phase", visibility: "public" },
  searches: { amount: 2, reset: "decision", visibility: "private" },
} as const;
describe("safe named allowances", () => {
  it("rejects costs that mint allowance or poison the balance", () => {
    const book = core.initResourceBook([seat], resources);
    for (const cost of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = core.spendResource(book, seat, "fuel", cost);
      expect(result.ok).toBe(false);
      expect(result.book).toBe(book);
      expect(core.remainingResource(book, seat, "fuel")).toBe(4);
    }
  });

  it("never spends undeclared or inherited keys including a zero-cost request", () => {
    const book = core.initResourceBook([seat], resources);
    for (const key of ["unknown", "constructor", "__proto__", "toString"]) {
      expect(core.remainingResource(book, seat, key)).toBe(0);
      expect(core.spendResource(book, seat, key, 0)).toEqual({ book, ok: false });
    }
    expect(core.spendResource(book, "constructor" as core.SeatId, "fuel", 0)).toEqual({
      book,
      ok: false,
    });
  });

  it("conserves balances while isolating seats and original books", () => {
    let book = core.initResourceBook([seat, otherSeat], resources);
    expect(book?.[seat]).toEqual({ fuel: 4, messages: 3, searches: 2 });
    if (!book) return;
    const original = book;
    for (const amount of [1, 1, 2]) {
      const result = core.spendResource(book, seat, "fuel", amount);
      expect(result.ok).toBe(true);
      book = result.book;
    }
    expect(core.remainingResource(book, seat, "fuel")).toBe(0);
    expect(core.remainingResource(book, otherSeat, "fuel")).toBe(4);
    expect(core.remainingResource(original, seat, "fuel")).toBe(4);
    expect(core.spendResource(book, seat, "fuel", 1).ok).toBe(false);
  });

  it("renews only the requested reset scope and never match allowances", () => {
    const initial = core.initResourceBook([seat, otherSeat], resources);
    expect(initial).toBeDefined();
    if (!initial) return;
    let book = core.spendResource(initial, seat, "fuel", 4).book;
    book = core.spendResource(book, seat, "messages", 3).book;
    book = core.spendResource(book, seat, "searches", 2).book;
    book = core.resetResources(book, seat, resources, "decision");
    expect(book[seat]).toEqual({ fuel: 0, messages: 0, searches: 2 });
    book = core.spendResource(book, seat, "searches", 1).book;
    book = core.resetResources(book, seat, resources, "phase");
    expect(book[seat]).toEqual({ fuel: 0, messages: 3, searches: 1 });
    expect(book[otherSeat]).toEqual({ fuel: 4, messages: 3, searches: 2 });
  });

  it("projects all own resources and only declared public resources for spectators", () => {
    const book = core.initResourceBook([seat], resources);
    expect(book).toBeDefined();
    if (!book) return;
    expect(core.resourceBalances(book, seat, resources)).toEqual({
      fuel: 4,
      messages: 3,
      searches: 2,
    });
    expect(core.resourceBalances(book, seat, resources, "public")).toEqual({ messages: 3 });
    expect(core.resourceBalances(book, otherSeat, resources, "public")).toEqual({ messages: 0 });
  });

  it("rejects malformed resource definitions before initializing or resetting", () => {
    expect(core.initResourceBook).toBeDefined();
    if (!core.initResourceBook) return;
    const malformed = { fuel: { ...resources.fuel, amount: -1 } };
    expect(() => core.initResourceBook([seat], malformed)).toThrow();
    const book = core.initResourceBook([seat], resources);
    expect(() => core.resetResources(book, seat, malformed, "phase")).toThrow();
  });
});

describe("exact integer resource units", () => {
  it("rejects fractional and oversized definitions before a match can consume them", () => {
    for (const amount of [0.3, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE]) {
      expect(() =>
        core.initResourceBook([seat], { fuel: { ...resources.fuel, amount } }),
      ).toThrow();
    }
  });

  it("refuses corrupted fractional or oversized balances without changing the book", () => {
    for (const amount of [0.3, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE]) {
      const book = { [seat]: { fuel: amount } };
      expect(core.remainingResource(book, seat, "fuel")).toBe(0);
      expect(core.spendResource(book, seat, "fuel", 0)).toEqual({ book, ok: false });
    }
  });

  it("spends every integer unit exactly through exhaustion including the maximum safe balance", () => {
    for (const amount of [0, 1, 2, 3, 13, 256]) {
      let book = core.initResourceBook([seat], { fuel: { ...resources.fuel, amount } });
      for (let consumed = 1; consumed <= amount; consumed++) {
        const next = core.spendResource(book, seat, "fuel", 1);
        expect(next.ok).toBe(true);
        book = next.book;
        expect(core.remainingResource(book, seat, "fuel")).toBe(amount - consumed);
      }
      expect(core.remainingResource(book, seat, "fuel")).toBe(0);
      expect(core.spendResource(book, seat, "fuel", 1).ok).toBe(false);
    }
    const book = core.initResourceBook([seat], {
      fuel: { ...resources.fuel, amount: Number.MAX_SAFE_INTEGER },
    });
    const first = core.spendResource(book, seat, "fuel", 1);
    expect(first.ok).toBe(true);
    expect(core.remainingResource(first.book, seat, "fuel")).toBe(Number.MAX_SAFE_INTEGER - 1);
    const last = core.spendResource(first.book, seat, "fuel", Number.MAX_SAFE_INTEGER - 1);
    expect(last.ok).toBe(true);
    expect(core.remainingResource(last.book, seat, "fuel")).toBe(0);
  });
});

describe("resource accounting boundaries", () => {
  it("rejects malformed costs without changing balances", () => {
    const book = core.initResourceBook([seat], resources);
    for (const cost of [
      -1,
      0.1,
      Number.MAX_SAFE_INTEGER + 1,
      Number.MAX_VALUE,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(core.spendResource(book, seat, "fuel", cost)).toEqual({ book, ok: false });
    }
  });
});
