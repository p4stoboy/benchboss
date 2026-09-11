import { createHash } from "node:crypto";
import type { Rng } from "./types";

const MASK = (1n << 64n) - 1n;

type State = [bigint, bigint, bigint, bigint];

function splitmix64Next(state: { s: bigint }): bigint {
  state.s = (state.s + 0x9e3779b97f4a7c15n) & MASK;
  let z = state.s;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  z = z ^ (z >> 31n);
  return z & MASK;
}

function rotl(x: bigint, k: bigint): bigint {
  return ((x << k) | (x >> (64n - k))) & MASK;
}

function fnv1a64(label: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(label, "utf8")) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & MASK;
  }
  return h & MASK;
}

function seedToU64(seedHex: string): bigint {
  const digest = createHash("sha256").update(seedHex).digest();
  let s = 0n;
  for (let i = 0; i < 8; i++) s = (s << 8n) | BigInt(digest[i] as number);
  return s & MASK;
}

function fillState(seed64: bigint): State {
  const sm = { s: seed64 };
  return [splitmix64Next(sm), splitmix64Next(sm), splitmix64Next(sm), splitmix64Next(sm)];
}

export function sha256Commit(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function makeRng(seed: string, s: State): Rng {
  const nextU64 = (): bigint => {
    const result = (rotl((s[1] * 5n) & MASK, 7n) * 9n) & MASK;
    const t = (s[1] << 17n) & MASK;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl(s[3], 45n);
    return result & MASK;
  };
  const nextU32 = (): number => Number((nextU64() >> 32n) & 0xffffffffn);
  const nextFloat = (): number => Number(nextU64() >> 11n) * 2 ** -53;
  const int = (maxExclusive: number): number => nextU32() % maxExclusive;
  const pick = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  const shuffle = <T>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = int(i + 1);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  };
  const fork = (label: string): Rng =>
    makeRng(`${seed}#${label}`, fillState((s[0] ^ fnv1a64(label)) & MASK));
  return { seed, nextU32, nextFloat, int, pick, shuffle, fork };
}

export function createRng(seed: string): Rng {
  return makeRng(seed, fillState(seedToU64(seed)));
}
