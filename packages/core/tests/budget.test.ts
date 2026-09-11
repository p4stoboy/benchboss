import { describe, expect, test } from "bun:test";
import {
  initBudgetBook,
  mkSeatId,
  remaining,
  resetTurnBudgets,
  safeDefaultTriggered,
  spend,
} from "../src/index";
import type { BudgetConfig } from "../src/index";

const budgets: BudgetConfig = {
  wallClockMsPerDecision: 5000,
  toolCallsPerTurn: 3,
  intelOrScoutPoints: 2,
  simRolloutsPerTurn: 4,
  invalidRetries: 1,
};
const seats = [mkSeatId(0), mkSeatId(1)];

describe("budget ledger", () => {
  test("remaining_reports_configured_maxima_initially", () => {
    const book = initBudgetBook(seats, budgets);
    expect(remaining(book, mkSeatId(0), "toolCallsPerTurn")).toBe(3);
    expect(remaining(book, mkSeatId(0), "intelOrScoutPoints")).toBe(2);
  });

  test("spend_decrements_and_returns_true_when_sufficient", () => {
    let book = initBudgetBook(seats, budgets);
    const r = spend(book, mkSeatId(0), "toolCallsPerTurn", 2);
    book = r.book;
    expect(r.ok).toBe(true);
    expect(remaining(book, mkSeatId(0), "toolCallsPerTurn")).toBe(1);
  });

  test("spend_returns_false_and_does_not_decrement_when_insufficient", () => {
    let book = initBudgetBook(seats, budgets);
    const r = spend(book, mkSeatId(0), "intelOrScoutPoints", 3);
    book = r.book;
    expect(r.ok).toBe(false);
    expect(remaining(book, mkSeatId(0), "intelOrScoutPoints")).toBe(2);
  });

  test("budgets_are_isolated_per_seat", () => {
    let book = initBudgetBook(seats, budgets);
    book = spend(book, mkSeatId(0), "toolCallsPerTurn", 3).book;
    expect(remaining(book, mkSeatId(0), "toolCallsPerTurn")).toBe(0);
    expect(remaining(book, mkSeatId(1), "toolCallsPerTurn")).toBe(3);
  });

  test("reset_restores_per_turn_keys_only", () => {
    let book = initBudgetBook(seats, budgets);
    book = spend(book, mkSeatId(0), "toolCallsPerTurn", 3).book;
    book = spend(book, mkSeatId(0), "simRolloutsPerTurn", 4).book;
    book = spend(book, mkSeatId(0), "intelOrScoutPoints", 2).book;
    book = spend(book, mkSeatId(0), "invalidRetries", 1).book;
    book = resetTurnBudgets(book, mkSeatId(0), budgets);
    // Per-turn keys are restored to their configured maxima.
    expect(remaining(book, mkSeatId(0), "toolCallsPerTurn")).toBe(3);
    expect(remaining(book, mkSeatId(0), "simRolloutsPerTurn")).toBe(4);
    // Per-match keys are NOT restored by reset() — they retain post-spend values.
    expect(remaining(book, mkSeatId(0), "intelOrScoutPoints")).toBe(0);
    expect(remaining(book, mkSeatId(0), "invalidRetries")).toBe(0);
  });

  test("remaining_returns_zero_for_unknown_seat", () => {
    const book = initBudgetBook(seats, budgets);
    expect(remaining(book, mkSeatId(99), "toolCallsPerTurn")).toBe(0);
  });

  test("returns_default_action_when_retry_budget_exhausted", () => {
    let book = initBudgetBook(seats, budgets);
    expect(safeDefaultTriggered(book, mkSeatId(0))).toBe(false);
    const r = spend(book, mkSeatId(0), "invalidRetries", 1);
    book = r.book;
    expect(r.ok).toBe(true);
    expect(safeDefaultTriggered(book, mkSeatId(0))).toBe(true);
  });
});
