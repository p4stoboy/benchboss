import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBenchBossClient, createHttpTransport } from "./api";
import { createMcpServer } from "./mcp";

const baseUrl = process.env.BENCHBOSS_URL;
if (!baseUrl)
  throw Error(
    "BENCHBOSS_URL is required. Hosts provide their own authentication transport or MCP adapter.",
  );
const client = createBenchBossClient({ transport: createHttpTransport({ baseUrl }) });
await createMcpServer(client).connect(new StdioServerTransport());
