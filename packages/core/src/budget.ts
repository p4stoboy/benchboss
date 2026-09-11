import type { BudgetConfig, SeatId } from "./types";

const PER_TURN_KEYS: ReadonlyArray<keyof BudgetConfig> = ["toolCallsPerTurn", "simRolloutsPerTurn"];

export type BudgetBook = Readonly<Record<SeatId, Record<keyof BudgetConfig, number>>>;

export function initBudgetBook(seats: SeatId[], budgets: BudgetConfig): BudgetBook {
  const book: Record<SeatId, Record<keyof BudgetConfig, number>> = {};
  for (const seat of seats) book[seat] = { ...budgets };
  return book;
}

export function remaining(book: BudgetBook, seat: SeatId, key: keyof BudgetConfig): number {
  return book[seat]?.[key] ?? 0;
}

export function spend(
  book: BudgetBook,
  seat: SeatId,
  key: keyof BudgetConfig,
  n = 1,
): { book: BudgetBook; ok: boolean } {
  const row = book[seat];
  if (!row || row[key] < n) return { book, ok: false };
  return { book: { ...book, [seat]: { ...row, [key]: row[key] - n } }, ok: true };
}

export function resetTurnBudgets(
  book: BudgetBook,
  seat: SeatId,
  budgets: BudgetConfig,
): BudgetBook {
  const row = book[seat];
  if (!row) return book;
  const next = { ...row };
  for (const key of PER_TURN_KEYS) next[key] = budgets[key];
  return { ...book, [seat]: next };
}

export function safeDefaultTriggered(book: BudgetBook, seat: SeatId): boolean {
  return remaining(book, seat, "invalidRetries") <= 0;
}
