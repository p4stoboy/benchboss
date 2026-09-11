import { type MatchConfig, mkSeatId } from "@benchboss/core";
import { gameConfig } from "../../tests/config";
import { plugin } from "../src/plugin";

export function baseConfig(_rounds = 5): MatchConfig {
  const config = gameConfig(plugin.manifest, "m1", [0, 1, 2, 3, 4].map(mkSeatId));
  config.timing.decisionLimitMs = 1000;
  config.resources.retries = { amount: 2, reset: "match", visibility: "private" };
  return config;
}

export function handlerConfig(rounds = 5): MatchConfig {
  const base = baseConfig(rounds);
  return { ...base, rules: { ...base.rules, handler: true } };
}
