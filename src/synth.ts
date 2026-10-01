/**
 * 合成试验数据生成器。随机性可注入（默认 mulberry32 可复现 PRNG），
 * 不调用任何外部服务。
 */

export type Rng = () => number;

/** 可复现的小型 PRNG（mulberry32）。 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller 标准正态。 */
export function gaussian(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export type SynthScenario =
  | "main-only"
  | "interaction"
  | "constant"
  | "unequal-replication"
  | "missing-cell"
  | "extreme-scale";

export type GeneratedDesign = {
  name: string;
  factorA: string;
  factorB: string;
  aLevels: string[];
  bLevels: string[];
  observations: { aLevel: string; bLevel: string; value: number }[];
};

export function generate(
  scenario: SynthScenario,
  seed = 42,
  overrides: { a?: number; b?: number; n?: number } = {},
): GeneratedDesign {
  const rng = mulberry32(seed);
  const a = overrides.a ?? 2;
  const b = overrides.b ?? 2;
  const n = overrides.n ?? 3;
  const aLevels = Array.from({ length: a }, (_, i) => `A${i + 1}`);
  const bLevels = Array.from({ length: b }, (_, j) => `B${j + 1}`);
  const observations: GeneratedDesign["observations"] = [];

  const alpha = (i: number) => (scenario === "main-only" ? (i === 0 ? 3 : -3) : 0);
  const beta = (j: number) => (scenario === "main-only" ? (j === 0 ? 2 : -2) : 0);
  const interact = (i: number, j: number) =>
    scenario === "interaction" ? (i === j ? 4 : -4) : 0;

  for (let i = 0; i < a; i++) {
    for (let j = 0; j < b; j++) {
      let rep = n;
      if (scenario === "unequal-replication" && i === 0 && j === 0) rep = n + 1;
      if (scenario === "missing-cell" && i === a - 1 && j === b - 1) rep = 0;
      for (let k = 0; k < rep; k++) {
        let value: number;
        if (scenario === "constant") {
          value = 7;
        } else {
          const noise =
            scenario === "extreme-scale" ? gaussian(rng) * 1e6 : gaussian(rng);
          const mean = 10 + alpha(i) + beta(j) + interact(i, j);
          value =
            scenario === "extreme-scale"
              ? mean * 1e8 + noise
              : mean + noise;
        }
        observations.push({
          aLevel: aLevels[i],
          bLevel: bLevels[j],
          value,
        });
      }
    }
  }
  return {
    name: `synth-${scenario}`,
    factorA: "FactorA",
    factorB: "FactorB",
    aLevels,
    bLevels,
    observations,
  };
}
