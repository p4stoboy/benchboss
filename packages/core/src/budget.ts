import {
  type ResourceAllowances,
  type ResourceBalances,
  isResourceAmount,
  validateResources,
} from "@benchboss/protocol";
import type { BudgetConfig, SeatId } from "./types";

const PER_TURN_KEYS: ReadonlyArray<keyof BudgetConfig> = ["toolCallsPerTurn", "simRolloutsPerTurn"];

export type BudgetBook = Readonly<Record<SeatId, Record<string, number>>>;

const isAmount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const isSafeKey = (value: string): boolean =>
  value !== "__proto__" && value !== "prototype" && value !== "constructor";

function rowFor(book: BudgetBook, seat: SeatId): Record<string, number> | undefined {
  return isSafeKey(seat) && Object.hasOwn(book, seat) ? book[seat] : undefined;
}

export function initBudgetBook(seats: SeatId[], budgets: BudgetConfig): BudgetBook {
  return Object.fromEntries(seats.map((seat) => [seat, { ...budgets }]));
}

export function initResourceBook(seats: SeatId[], resources: ResourceAllowances): BudgetBook {
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

export function remaining(book: BudgetBook, seat: SeatId, key: string): number {
  const row = rowFor(book, seat);
  if (!row || !isSafeKey(key) || !Object.hasOwn(row, key)) return 0;
  const value = row[key];
  return isAmount(value) ? value : 0;
}

export function spend(
  book: BudgetBook,
  seat: SeatId,
  key: string,
  n = 1,
): { book: BudgetBook; ok: boolean } {
  const row = rowFor(book, seat);
  if (!row || !isSafeKey(key) || !Object.hasOwn(row, key) || !isAmount(n))
    return { book, ok: false };
  const value = row[key];
  if (!isAmount(value) || value < n) return { book, ok: false };
  return { book: { ...book, [seat]: { ...row, [key]: value - n } }, ok: true };
}

/** Current resources use exact nonnegative safe-integer units; legacy budgets retain finite units. */
export function remainingResource(book: BudgetBook, seat: SeatId, key: string): number {
  const value = remaining(book, seat, key);
  return isResourceAmount(value) ? value : 0;
}

export function spendResource(
  book: BudgetBook,
  seat: SeatId,
  key: string,
  n = 1,
): { book: BudgetBook; ok: boolean } {
  const row = rowFor(book, seat);
  if (
    !row ||
    !isSafeKey(key) ||
    !Object.hasOwn(row, key) ||
    !isResourceAmount(row[key]) ||
    !isResourceAmount(n)
  )
    return { book, ok: false };
  return spend(book, seat, key, n);
}

/** Renew only the named scope; callers own phase epochs and accepted decisions. */
export function resetResources(
  book: BudgetBook,
  seat: SeatId,
  resources: ResourceAllowances,
  scope: "phase" | "decision",
): BudgetBook {
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
  book: BudgetBook,
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

export function resetTurnBudgets(
  book: BudgetBook,
  seat: SeatId,
  budgets: BudgetConfig,
): BudgetBook {
  const row = rowFor(book, seat);
  if (!row) return book;
  const next = { ...row };
  for (const key of PER_TURN_KEYS) next[key] = budgets[key];
  return { ...book, [seat]: next };
}

export function safeDefaultTriggered(book: BudgetBook, seat: SeatId): boolean {
  return remaining(book, seat, "invalidRetries") <= 0;
}
