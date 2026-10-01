import test from "node:test";
import assert from "node:assert/strict";
import { anova2 } from "../src/stats/anova.ts";
import { compareMarginals } from "../src/stats/compare.ts";
import { fUpperTail, holm, regularizedBeta, tTwoSided } from "../src/stats/dist.ts";
import { make2x2 } from "./helpers.ts";

test("手算 2x2：平方和、自由度、MS、F 与已知 p 值", () => {
  const cells = [[5, 6, 7], [7, 8, 9], [9, 10, 11], [11, 12, 13]];
  const labels = [["a1", "b1"], ["a1", "b2"], ["a2", "b1"], ["a2", "b2"]];
  const observations = cells.flatMap((vals, i) =>
    vals.map((v) => ({ aLevel: labels[i][0], bLevel: labels[i][1], value: v }))
  );
  const r = anova2({ aLevels: ["a1", "a2"], bLevels: ["b1", "b2"], observations });
  const row = (s: string) => r.rows.find((x) => x.source === s)!;
  assert.equal(row("A").ss, 48);
  assert.equal(row("B").ss, 12);
  assert.equal(row("AB").ss, 0);
  assert.equal(row("error").ss, 8);
  assert.equal(row("total").ss, 68);
  assert.equal(row("A").df, 1);
  assert.equal(row("error").df, 8);
  assert.equal(row("total").df, 11);
  assert.equal(row("A").ms, 48);
  assert.equal(row("error").ms, 1);
  assert.equal(row("A").f, 48);
  assert.equal(row("B").f, 12);
  assert.equal(row("AB").f, 0);
  // 已知分布值：F(1,8) 在 5.317 处 p≈0.05
  assert.ok(Math.abs(fUpperTail(5.317, 1, 8) - 0.05) < 1e-3);
  assert.ok((row("A").p ?? 1) < 0.001);
  assert.ok(Math.abs((row("B").p ?? 0) - 0.00852) < 2e-4);
  assert.equal(row("AB").p, 1);
  assert.deepEqual(r.cellMeans.map((c) => c.mean), [6, 8, 10, 12]);
  assert.ok(r.cellMeans.every((c) => c.interactionEffect === 0));
});

test("平方和恒等式 SS_A+SS_B+SS_AB+SS_E = SS_total", () => {
  const r = anova2(make2x2({ alpha: 2, beta: 1, ab: 1.5, noise: 0.3, n: 4 }));
  const ss = Object.fromEntries(r.rows.map((x) => [x.source, x.ss]));
  assert.ok(Math.abs(ss.A + ss.B + ss.AB + ss.error - ss.total) < 1e-8);
});

test("纯主效应：交互为零；纯交互：主效应为零", () => {
  const main = anova2(make2x2({ alpha: 5, beta: 0, ab: 0 }));
  assert.equal(main.rows.find((x) => x.source === "AB")!.ss, 0);
  assert.ok(main.rows.find((x) => x.source === "A")!.ss > 0);
  const inter = anova2(make2x2({ alpha: 0, beta: 0, ab: 5 }));
  assert.equal(inter.rows.find((x) => x.source === "A")!.ss, 0);
  assert.equal(inter.rows.find((x) => x.source === "B")!.ss, 0);
  assert.ok(inter.rows.find((x) => x.source === "AB")!.ss > 0);
});

test("全常量：MSE=0 且无变异，p 置空并标记 NO_VARIATION", () => {
  const r = anova2(make2x2({ alpha: 0, beta: 0, ab: 0, noise: 0, base: 7 }));
  assert.equal(r.mseZero, "NO_VARIATION");
  for (const src of ["A", "B", "AB"]) {
    const row = r.rows.find((x) => x.source === src)!;
    assert.equal(row.p, null);
    assert.equal(row.pNullReason, "NO_VARIATION");
    assert.equal(row.f, null);
  }
});

test("完全拟合（格内无变异、格间有差异）：p 置空并标记 PERFECT_FIT，F 不产生误导", () => {
  const r = anova2(make2x2({ alpha: 3, beta: 0, ab: 0, noise: 0 }));
  assert.equal(r.mseZero, "PERFECT_FIT");
  const a = r.rows.find((x) => x.source === "A")!;
  assert.equal(a.p, null);
  assert.equal(a.pNullReason, "PERFECT_FIT");
  assert.equal(a.f, Infinity);
});

test("拒绝：缺失格子 / 不等重复 / 非有限 / 重复不足", () => {
  const base = make2x2({});
  const missing = { ...base, observations: base.observations.filter(
    (o) => !(o.aLevel === "a2" && o.bLevel === "b2")) };
  assert.throws(() => anova2(missing), (e: any) => e.code === "MISSING_CELL");

  const unequal = { ...base, observations: [...base.observations,
    { aLevel: "a1", bLevel: "b1", value: 6 }] };
  assert.throws(() => anova2(unequal), (e: any) => e.code === "UNEQUAL_REPLICATION");

  const bad = make2x2({});
  bad.observations[0].value = NaN;
  assert.throws(() => anova2(bad), (e: any) => e.code === "NON_FINITE_OBS");

  const one = make2x2({ n: 1 });
  assert.throws(() => anova2(one), (e: any) => e.code === "INSUFFICIENT_REPLICATION");
});

test("水平重排不改变平方和（仅边际均值顺序变化）", () => {
  const d = make2x2({ alpha: 2, beta: 1, ab: 1.5, noise: 0.4 });
  const r1 = anova2(d);
  const reordered = {
    aLevels: ["a2", "a1"],
    bLevels: ["b2", "b1"],
    observations: d.observations,
  };
  const r2 = anova2(reordered);
  for (const src of ["A", "B", "AB", "error", "total"]) {
    assert.ok(Math.abs(
      r1.rows.find((x) => x.source === src)!.ss -
      r2.rows.find((x) => x.source === src)!.ss) < 1e-10);
  }
});

test("极端尺度数值稳定：中心化计算保持分解恒等式", () => {
  const d = make2x2({ alpha: 5, beta: 2, ab: 1, n: 4, noise: 0.5 });
  d.observations.forEach((o) => { o.value = o.value * 1e9 + 1e12; });
  const r = anova2(d);
  const ss = Object.fromEntries(r.rows.map((x) => [x.source, x.ss]));
  const relErr =
    Math.abs(ss.A + ss.B + ss.AB + ss.error - ss.total) / Math.max(1, ss.total);
  assert.ok(relErr < 1e-9);
  assert.ok(Number.isFinite(r.rows.find((x) => x.source === "A")!.f));
});

test("成对边际比较使用共同 MSE，Holm 校正可追查且单调", () => {
  const d = make2x2({ alpha: 4, beta: 0, ab: 0, n: 5, noise: 0.5 });
  const r = anova2(d);
  const { familyA } = compareMarginals(r);
  assert.equal(familyA.count, 1);
  const c = familyA.comparisons[0];
  assert.ok(c.rawP !== null && c.adjustedP !== null);
  assert.equal(c.adjustedP, c.rawP);
  assert.match(familyA.family, /共同误差均方/);
});

test("Holm 多比较：adjusted >= raw 且单调", () => {
  const res = holm([0.001, 0.04, 0.03, 0.9]);
  for (const x of res) assert.ok(x.adjusted >= x.raw - 1e-15);
  const sortedRaw = [...res].sort((a, b) => a.raw - b.raw);
  assert.ok(sortedRaw[0].adjusted <= sortedRaw[1].adjusted);
  assert.ok(sortedRaw[1].adjusted <= sortedRaw[2].adjusted);
});

test("已知分布值核对（Beta / F / t）", () => {
  // I_0.5(1,1)=0.5；I_x(a,b) 对称
  assert.ok(Math.abs(regularizedBeta(0.5, 1, 1) - 0.5) < 1e-12);
  assert.ok(Math.abs(regularizedBeta(0.2, 3, 5) + regularizedBeta(0.8, 5, 3) - 1) < 1e-10);
  // F(2,10) 95% 临界值 4.103
  assert.ok(Math.abs(fUpperTail(4.103, 2, 10) - 0.05) < 1e-3);
  // t(10) 双侧 0.05 临界值 2.228
  assert.ok(Math.abs(tTwoSided(2.228, 10) - 0.05) < 1e-3);
  // F 上尾单调性
  assert.ok(fUpperTail(1, 4, 20) > fUpperTail(4, 4, 20));
});

test("未知水平被拒绝", () => {
  const d = make2x2({});
  d.observations[0].aLevel = "zzz";
  assert.throws(() => anova2(d), (e: any) => e.code === "UNKNOWN_LEVEL");
});
