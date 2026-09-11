import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BenchBossClient } from "./api";
import { TOOLS, type ToolDef, toolListing } from "./tools";

export async function dispatchTool<C extends BenchBossClient>(
  client: C,
  name: string,
  args: unknown,
  tools: readonly ToolDef<C>[] = TOOLS,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  try {
    const parsed = tool.inputSchema.parse(args ?? {});
    const result = await tool.invoke(client, parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (error) {
    return { content: [{ type: "text", text: String(error) }], isError: true };
  }
}
export function createMcpServer<C extends BenchBossClient>(
  client: C,
  tools: readonly ToolDef<C>[] = TOOLS,
): Server {
  const server = new Server(
    { name: "benchboss", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolListing(tools) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    dispatchTool(client, request.params.name, request.params.arguments, tools),
  );
  return server;
}
