import { toInputSchema } from "@benchboss/schemas";
import { z } from "zod";
import { CLASS_IDS, TEAM_SIZE } from "./classes";

const point = z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }).strict();
const action = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("attack"), target: z.string() }).strict(),
  z
    .object({ kind: z.literal("ability"), target: z.string().optional(), at: point.optional() })
    .strict(),
  z.object({ kind: z.literal("pickup") }).strict(),
  z.object({ kind: z.literal("hold") }).strict(),
]);

export const CHAT_MAX_LENGTH = 280;
const chat = z.string().min(1).max(CHAT_MAX_LENGTH);

export const loadoutSchema = z
  .object({ actors: z.array(z.enum(CLASS_IDS)).length(TEAM_SIZE), chat: chat.optional() })
  .strict();

// Unit ids are validated semantically so the offer schema is one shared, compiled-once object.
export const ordersSchema = z
  .object({
    orders: z
      .array(
        z
          .object({ unit: z.string(), moveTo: point.optional(), action: action.optional() })
          .strict(),
      )
      .max(TEAM_SIZE),
    chat: chat.optional(),
  })
  .strict();

export const LOADOUT_INPUT_SCHEMA = toInputSchema(loadoutSchema);
export const ORDERS_INPUT_SCHEMA = toInputSchema(ordersSchema);
