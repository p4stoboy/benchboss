import { expect, test } from "bun:test";
import { SERVER_CAPABILITIES } from "@benchboss/protocol";
import { createBenchBossClient } from "../src/api";

test("rejects unversioned next and submit responses before accepting server data", async () => {
  for (const response of [{ kind: "idle" }, { ok: true, reason: "ok" }]) {
    const client = createBenchBossClient({
      transport: {
        async request(_method, path) {
          return path === "/capabilities" ? SERVER_CAPABILITIES : response;
        },
      },
    });
    await expect(
      "kind" in response ? client.next() : client.submit("m", "move", {}),
    ).rejects.toThrow("protocol_error");
  }
});
