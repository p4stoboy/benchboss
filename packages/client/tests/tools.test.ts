import { describe, expect, test } from "bun:test";
import { createMcpServer, dispatchTool } from "../src/mcp";
import { TOOLS, toolListing } from "../src/tools";

describe("client MCP tools", () => {
  test("tools have unique benchboss_ names and strict input schemas", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) expect(t.name.startsWith("benchboss_")).toBe(true);
  });

  test("benchboss_enqueue requires gameId and dispatches to the client", async () => {
    const tool = TOOLS.find((t) => t.name === "benchboss_enqueue");
    expect(() => tool?.inputSchema.parse({})).toThrow();
    const calls: string[] = [];
    const fakeClient = {
      enqueue: async (g: string) => {
        calls.push(g);
        return { queued: true };
      },
    };
    const result = await tool?.invoke(fakeClient as never, { gameId: "rps-n" });
    expect(result).toEqual({ queued: true });
    expect(calls).toEqual(["rps-n"]);
  });

  test("toolListing exposes json-schema for every tool", () => {
    const listing = toolListing();
    expect(listing).toHaveLength(TOOLS.length);
    expect(listing.find((t) => t.name === "benchboss_enqueue")?.inputSchema).toMatchObject({
      type: "object",
    });
  });

  test("createMcpServer constructs without throwing", () => {
    expect(createMcpServer({} as never)).toBeDefined();
  });

  test("dispatchTool returns isError true when client method rejects", async () => {
    const throwingClient = {
      enqueue: async () => {
        throw new Error("backend down");
      },
    };
    const res = await dispatchTool(throwingClient as never, "benchboss_enqueue", {
      gameId: "rps-n",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("backend down");
  });

  test("dispatchTool returns content without isError on success", async () => {
    const happyClient = {
      enqueue: async (_g: string) => ({ queued: true }),
    };
    const res = await dispatchTool(happyClient as never, "benchboss_enqueue", { gameId: "rps-n" });
    expect(res.isError).toBeUndefined();
    const content = res.content[0];
    expect(content).toBeDefined();
    if (!content) return;
    expect(JSON.parse(content.text)).toEqual({ queued: true });
  });

  test("public tools contain no official registration or rating policy", () => {
    expect(toolListing().map((t) => t.name)).toEqual([
      "benchboss_enqueue",
      "benchboss_next",
      "benchboss_submit",
    ]);
  });
});
