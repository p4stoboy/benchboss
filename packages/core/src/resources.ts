import {
  type ResourceAllowances,
  type ResourceBalances,
  isResourceAmount,
  validateResources,
} from "@benchboss/protocol";
import type { SeatId } from "./types";

export type ResourceBook = Readonly<Record<SeatId, Record<string, number>>>;

const isSafeKey = (value: string): boolean =>
  value !== "__proto__" && value !== "prototype" && value !== "constructor";

function rowFor(book: ResourceBook, seat: SeatId): Record<string, number> | undefined {
  return isSafeKey(seat) && Object.hasOwn(book, seat) ? book[seat] : undefined;
}

export function initResourceBook(seats: SeatId[], resources: ResourceAllowances): ResourceBook {
  const validation = validateResources(resources);
  if (!validation.ok) throw Error(validation.reason);
  return Object.fromEntries(
    seats.map((seat) => [
      seat,
      Object.fromEntries(
        Object.entries(resources).map(([name, resource]) => [name, resource.amount]),
      ),
    ]),
  );
}

export function remainingResource(book: ResourceBook, seat: SeatId, key: string): number {
  const row = rowFor(book, seat);
  if (!row || !isSafeKey(key) || !Object.hasOwn(row, key)) return 0;
  const value = row[key];
  return isResourceAmount(value) ? value : 0;
}

export function spendResource(
  book: ResourceBook,
  seat: SeatId,
  key: string,
  n = 1,
): { book: ResourceBook; ok: boolean } {
  const row = rowFor(book, seat);
  if (
    !row ||
    !isSafeKey(key) ||
    !Object.hasOwn(row, key) ||
    !isResourceAmount(row[key]) ||
    !isResourceAmount(n)
  )
    return { book, ok: false };
  const value = row[key];
  if (value === undefined || value < n) return { book, ok: false };
  return { book: { ...book, [seat]: { ...row, [key]: value - n } }, ok: true };
}

/** Renew only the named scope; callers own phase epochs and accepted decisions. */
export function resetResources(
  book: ResourceBook,
  seat: SeatId,
  resources: ResourceAllowances,
  scope: "phase" | "decision",
): ResourceBook {
  const validation = validateResources(resources);
  if (!validation.ok) throw Error(validation.reason);
  if (scope !== "phase" && scope !== "decision") throw Error("invalid resource reset scope");
  const row = rowFor(book, seat);
  if (!row) return book;
  const next = { ...row };
  for (const [name, resource] of Object.entries(resources)) {
    if (resource.reset === scope && Object.hasOwn(row, name)) next[name] = resource.amount;
  }
  return { ...book, [seat]: next };
}

/** Private projections are the seat's own balances; public projections omit private definitions. */
export function resourceBalances(
  book: ResourceBook,
  seat: SeatId,
  resources: ResourceAllowances,
  visibility: "private" | "public" = "private",
): ResourceBalances {
  const validation = validateResources(resources);
  if (!validation.ok) throw Error(validation.reason);
  if (visibility !== "private" && visibility !== "public")
    throw Error("invalid resource projection visibility");
  return Object.fromEntries(
    Object.entries(resources)
      .filter(([, resource]) => visibility === "private" || resource.visibility === "public")
      .map(([name]) => [name, remainingResource(book, seat, name)]),
  );
}
