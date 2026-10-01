import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDb, Store } from "../src/db.ts";

export function tempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "anova-test-"));
  const db = openDb(join(dir, "t.db"));
  migrate(db);
  return new Store(db);
}

export function closeStore(s: Store) {
  s.db.close();
}

/** 生成平衡 2x2 数据；可分别加主效应与交互效应。 */
export function make2x2(opts: {
  alpha?: number;
  beta?: number;
  ab?: number;
  n?: number;
  noise?: number;
  base?: number;
}) {
  const n = opts.n ?? 3;
  const alpha = opts.alpha ?? 0;
  const beta = opts.beta ?? 0;
  const ab = opts.ab ?? 0;
  const noise = opts.noise ?? 0;
  const base = opts.base ?? 10;
  const observations: { aLevel: string; bLevel: string; value: number }[] = [];
  const aLevels = ["a1", "a2"];
  const bLevels = ["b1", "b2"];
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const eff =
        base + (i === 0 ? alpha : -alpha) + (j === 0 ? beta : -beta) +
        (i === j ? ab : -ab);
      for (let r = 0; r < n; r++) {
        observations.push({
          aLevel: aLevels[i],
          bLevel: bLevels[j],
          value: eff + (noise === 0 ? 0 : noise * (rand() - 0.5) * 2),
        });
      }
    }
  }
  return { aLevels, bLevels, observations };
}
