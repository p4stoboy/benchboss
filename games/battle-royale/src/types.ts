import type { SeatId } from "@benchboss/core";
import type { ClassId } from "./classes";
import type { GameMap } from "./map";

export type Phase = "loadout" | "orders" | "terminal";

export interface Point {
  x: number;
  y: number;
}

export interface Unit {
  id: string;
  seat: SeatId;
  slot: number;
  cls: ClassId;
  x: number;
  y: number;
  hp: number;
  alive: boolean;
}

export type Action =
  | { kind: "attack"; target: string }
  | { kind: "heal"; target: string }
  | { kind: "hold" };

export interface UnitOrder {
  unit: string;
  moveTo?: Point;
  action?: Action;
}

export interface Orders {
  orders: UnitOrder[];
}

/** One all-chat line, posted with an accepted loadout or orders envelope. */
export interface ChatMessage {
  round: number;
  seat: SeatId;
  text: string;
}

export type RoundEvent =
  | { kind: "move"; unit: string; from: Point; to: Point; blocked: boolean }
  | { kind: "attack"; unit: string; from: Point; target: string; at: Point; damage: number }
  | { kind: "fizzle"; unit: string; target: string; reason: string }
  | { kind: "heal"; unit: string; from: Point; target: string; at: Point; amount: number }
  | { kind: "storm"; unit: string; at: Point; damage: number }
  | { kind: "death"; unit: string; at: Point }
  | { kind: "eliminated"; seat: SeatId; placement: number };

export interface SeenUnit {
  id: string;
  seat: SeatId;
  cls: ClassId;
  x: number;
  y: number;
  hp: number;
  round: number;
}

export interface TeamRecord {
  seat: SeatId;
  /** Null while the team is alive. */
  placement: number | null;
  eliminatedRound: number | null;
  kills: number;
  damageDealt: number;
}

export interface RoundSnapshot {
  round: number;
  units: { id: string; x: number; y: number; hp: number }[];
}

export interface BrState {
  matchId: string;
  seed: string;
  phase: Phase;
  seats: SeatId[];
  rules: { maxRounds: number; tilesPerSeat: number };
  map: GameMap;
  round: number;
  loadouts: Record<SeatId, ClassId[]>;
  units: Unit[];
  orders: Record<SeatId, Orders>;
  /** Resolved movement per ordered unit, computed when the order was accepted. */
  paths: Record<SeatId, Record<string, Point[]>>;
  teams: Record<SeatId, TeamRecord>;
  memory: Record<SeatId, Record<string, SeenUnit>>;
  lastRound: RoundEvent[];
  history: RoundSnapshot[];
  /** Global, public, append-only. */
  chat: ChatMessage[];
  cause: string | null;
}
