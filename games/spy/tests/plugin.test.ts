import { describe, expect, test } from "bun:test";
import { plugin } from "../src/plugin";

describe("spy plugin", () => {
  test("declares safehouse-protocol with 5 seats and a sensing budget", () => {
    expect(plugin.id).toBe("safehouse-protocol");
    expect(plugin.defaultSeats).toBe(5);
    expect(plugin.manifest.defaultResources.research.amount).toBeGreaterThan(0);
    expect(plugin.senseResolvers?.("seed").length ?? 0).toBe(6);
  });
});
