import { describe, expect, test } from "bun:test";
import { createRng, sha256Commit } from "../src/index";

describe("deterministic PRNG", () => {
  test("fixed_seed_yields_fixed_first_eight_u32s", () => {
    const rng = createRng("benchboss-seed-0");
    const got = Array.from({ length: 8 }, () => rng.nextU32());
    expect(got).toEqual([
      3466244890, 2168183103, 97311740, 365060316, 1121064602, 376508503, 62832665, 923017854,
    ]);
  });

  test("same_seed_two_instances_agree_step_for_step", () => {
    const a = createRng("benchboss-seed-0");
    const b = createRng("benchboss-seed-0");
    for (let i = 0; i < 32; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  test("next_float_is_first_value_for_known_seed", () => {
    const rng = createRng("benchboss-seed-0");
    expect(rng.nextFloat()).toBeCloseTo(0.8070480289626432, 15);
  });

  test("next_float_is_in_unit_interval", () => {
    const rng = createRng("anything");
    for (let i = 0; i < 1000; i++) {
      const f = rng.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  test("int_is_bounded_below_max_exclusive", () => {
    const rng = createRng("bounds");
    for (let i = 0; i < 1000; i++) expect(rng.int(6)).toBeLessThan(6);
  });

  test("fisher_yates_shuffle_is_deterministic_for_fixed_seed", () => {
    const rng = createRng("shuffle-seed");
    const arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    rng.shuffle(arr);
    expect(arr).toEqual([1, 2, 0, 9, 5, 6, 3, 4, 8, 7]);
  });

  test("shuffle_is_a_permutation", () => {
    const rng = createRng("perm");
    const arr = Array.from({ length: 50 }, (_, i) => i);
    rng.shuffle(arr);
    expect([...arr].sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  test("fork_label_yields_independent_deterministic_substream", () => {
    const parent = createRng("fork-base");
    const child = parent.fork("combat");
    const got = Array.from({ length: 4 }, () => child.nextU32());
    expect(got).toEqual([2763176048, 1614130403, 3685888526, 2226622761]);
  });

  test("fork_with_different_labels_diverges", () => {
    const p = createRng("fork-base");
    const a = p.fork("alpha").nextU32();
    const q = createRng("fork-base");
    const b = q.fork("beta").nextU32();
    expect(a).not.toBe(b);
  });

  test("seed_property_echoes_the_hex_seed", () => {
    expect(createRng("xyz").seed).toBe("xyz");
  });

  test("sha256_commit_is_stable_hex_digest", () => {
    expect(sha256Commit("benchboss-seed-0")).toBe(sha256Commit("benchboss-seed-0"));
    expect(sha256Commit("a")).not.toBe(sha256Commit("b"));
    expect(sha256Commit("a")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("sha256_commit_pins_a_concrete_vector_for_a_known_seed", () => {
    // Locks the commit hash so a refactor cannot silently shift it (replay
    // reproducibility root). Vector computed from the real implementation.
    expect(sha256Commit("benchboss-seed-0")).toBe(
      "899861696d2baa4d2ab1dbf09da0a81856c7a638b4886ca767f3d7d684e83764",
    );
  });
});
