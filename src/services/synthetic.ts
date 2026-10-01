import { createDesign, systemClock } from "./repo.ts";
import type { Clock } from "./repo.ts";
import type { DB } from "../db/database.ts";

// Deterministic PRNG (mulberry32) so synthetic datasets and demos are repeatable.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller normal variates from the injected uniform source.
export function normal(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export type Scenario = "main" | "interaction" | "constant" | "extreme";

export interface ScenarioResult {
  designId: number;
  scenario: Scenario;
}

/**
 * Generate a balanced 2x3 design with n replicates.
 * Effects are explicit so test fixtures can assert the expected pattern.
 */
export function generateScenario(
  db: DB,
  scenario: Scenario,
  n = 3,
  seed = 12345,
  clock: Clock = systemClock,
): ScenarioResult {
  const rng = mulberry32(seed);
  const aLevels = ["a1", "a2"];
  const bLevels = ["b1", "b2", "b3"];
  const observations: { level_a: string; level_b: string; replicate: number; value: number }[] = [];

  // Effect tables: row effect (A), column effect (B), interaction (AB).
  const rowEff = scenario === "main" ? [5, -5] : [0, 0];
  const colEff = scenario === "main" ? [0, 2, -2] : [0, 0, 0];
  const inter: number[][] =
    scenario === "interaction"
      ? [
          [10, -5, -5],
          [-10, 5, 5],
        ]
      : [
          [0, 0, 0],
          [0, 0, 0],
        ];

  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 3; j++) {
      for (let r = 1; r <= n; r++) {
        let mean = 100 + rowEff[i]! + colEff[j]! + inter[i]![j]!;
        if (scenario === "constant") mean = 42;
        let value: number;
        if (scenario === "constant") {
          value = mean;
        } else {
          const noise = scenario === "extreme" ? normal(rng) * 1e6 : normal(rng) * 1.0;
          const base = scenario === "extreme" ? 1e12 : mean;
          value = base + noise;
        }
        observations.push({
          level_a: aLevels[i]!,
          level_b: bLevels[j]!,
          replicate: r,
          value,
        });
      }
    }
  }

  const designId = createDesign(
    db,
    {
      name: `synthetic:${scenario}`,
      factorA: { name: "A", levels: aLevels },
      factorB: { name: "B", levels: bLevels },
      observations,
    },
    clock,
  );
  return { designId, scenario };
}
