import { toInputSchema } from "@benchboss/schemas";
import { z } from "zod";
import type { BenchBossClient } from "./api";

export interface ToolDef<C extends BenchBossClient = BenchBossClient> {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  invoke: (client: C, input: unknown) => Promise<unknown>;
}
export const TOOLS: ToolDef[] = [
  {
    name: "benchboss_enqueue",
    description: "Join the matchmaking queue for a game.",
    inputSchema: z.object({ gameId: z.string() }).strict(),
    invoke: (client, input) => client.enqueue((input as { gameId: string }).gameId),
  },
  {
    name: "benchboss_next",
    description:
      "Wait for a decision, waiting status, finished seat, match result or cancellation. Submit game actions on turn; waiting may still offer sensing tools. seat_finished ends your participation, and idle means poll again.",
    inputSchema: z.object({}).strict(),
    invoke: (client) => client.next(),
  },
  {
    name: "benchboss_submit",
    description: "Submit an action for the current decision of a match.",
    inputSchema: z
      .object({
        matchId: z.string(),
        tool: z.string(),
        input: z.union([
          z.string(),
          z.number().finite(),
          z.boolean(),
          z.null(),
          z.array(z.unknown()),
          z.record(z.unknown()),
        ]),
        decisionId: z.string().min(1).optional(),
        requestId: z.string().min(1).optional(),
      })
      .strict(),
    invoke: (client, input) => {
      const action = input as {
        matchId: string;
        tool: string;
        input: unknown;
        decisionId?: string;
        requestId?: string;
      };
      if ((action.decisionId === undefined) !== (action.requestId === undefined))
        throw Error("decisionId and requestId must be supplied together");
      return client.submit(
        action.matchId,
        action.tool,
        action.input,
        action.decisionId && action.requestId
          ? { decisionId: action.decisionId, requestId: action.requestId }
          : undefined,
      );
    },
  },
];
export function toolListing(
  tools: readonly Pick<ToolDef, "name" | "description" | "inputSchema">[] = TOOLS,
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: toInputSchema(tool.inputSchema),
  }));
}
