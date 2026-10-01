import { test } from "node:test";
import assert from "node:assert/strict";
import { anova } from "../src/stats/anova.ts";
import { fSurvival, tTwoSided, regularizedBeta } from "../src/stats/dist.ts";
import { AppError } from "../src/types.ts";

const A = { key: "A" as const, name: "A", levels: ["a1", "a2"] };
const B = { key: "B" as const, name: "B", levels: ["b1", "b2"] };

// Hand-computed 2x2, n=2 balanced table (no interaction by construction).
// cells:
//  a1b1: 10,12 (mean 11)  a1b2: 20,22 (21)
//  a2b1: 14,16 (15)       a2b2: 24,26 (25)
const DATA = [
  [[10, 12], [20, 22]],
  [[14, 16], [24, 26]],
];

test("hand-computed SS decomposition and degrees of freedom", () => {
  const r = anova(A, B, DATA);
  // Grand mean = (22+42+30+50)/8 = 144/8 = 18
  assert.equal(r.grandMean, 18);
  const by = Object.fromEntries(r.table.map((t) => [t.source, t]));
  // SS_A: row means 16, 20 -> 2*n*((16-18)^2+(20-18)^2)= 2*2*(4+4)=32
  assert.ok(Math.abs(by.A!.ss - 32) < 1e-9);
  // SS_B: col means 13, 23 -> a*n*((13-18)^2+(23-18)^2)=2*2*(25+25)=200
  assert.ok(Math.abs(by.B!.ss - 200) < 1e-9);
  // SS_AB: cell means fit additive model exactly -> 0
  assert.ok(Math.abs(by.AB!.ss) < 1e-9);
  // SS_error: within cell (1+1)+(1+1)+(1+1)+(1+1)=8
  assert.ok(Math.abs(by.Error!.ss - 8) < 1e-8);
  assert.equal(by.Error!.df, 4);
  assert.equal(by.Total!.df, 7);
  assert.equal(by.A!.df, 1);
  assert.equal(by.B!.df, 1);
  assert.equal(by.AB!.df, 1);
  // SS total = 240
  assert.ok(Math.abs(by.Total!.ss - (32 + 200 + 0 + 8)) < 1e-7);
  assert.equal(r.mse, 2);
  assert.equal(by.AB!.f, 0);
  assert.equal(by.AB!.p, 1);
});

test("SS additivity: SS total = SS_A + SS_B + SS_AB + SS_E", () => {
  const r = anova(A, B, DATA);
  const sum = r.table.slice(0, 4).reduce((acc, t) => acc + t.ss, 0);
  const total = r.table[4]!.ss;
  assert.ok(Math.abs(sum - total) < 1e-6 * Math.max(1, Math.abs(total)));
});

test("invariance to level reordering (same SS and F)", () => {
  const reorderedA = { key: "A" as const, name: "A", levels: ["a2", "a1"] };
  const reordered = [DATA[1]!, DATA[0]!];
  const r1 = anova(A, B, DATA);
  const r2 = anova(reorderedA, B, reordered);
  for (const s of ["A", "B", "AB", "Error", "Total"] as const) {
    const x = r1.table.find((t) => t.source === s)!;
    const y = r2.table.find((t) => t.source === s)!;
    assert.ok(Math.abs(x.ss - y.ss) < 1e-6, `${s} SS changed`);
    assert.ok(Math.abs((x.f ?? -1) - (y.f ?? -1)) < 1e-9, `${s} F changed`);
  }
});

test("pure interaction fixture: main effects ~ 0, interaction large", () => {
  // 2x2 n=2 with pure interaction:
  // [10,10] [-10,-10]
  // [-10,-10] [10,10]
  const d = [
    [[10, 10], [-10, -10]],
    [[-10, -10], [10, 10]],
  ];
  const r = anova(A, B, d);
  const by = Object.fromEntries(r.table.map((t) => [t.source, t]));
  assert.ok(Math.abs(by.A!.ss) < 1e-8);
  assert.ok(Math.abs(by.B!.ss) < 1e-8);
  // interaction SS: interaction effects are +/-10, *n=2 -> 800
  assert.ok(Math.abs(by.AB!.ss - 800) < 1e-6);
  assert.ok(by.AB!.p === null || by.AB!.p !== undefined);
  // zero MSE here because replicates are identical -> perfect fit note
  assert.equal(by.Error!.pNote, "ZERO_MSE_PERFECT_FIT");
  assert.equal(by.AB!.p, null);
});

test("fully constant data: zero MSE with NO_VARIATION note, no misleading p", () => {
  const d = [
    [[7, 7], [7, 7]],
    [[7, 7], [7, 7]],
  ];
  const r = anova(A, B, d);
  for (const t of r.table) {
    assert.equal(t.f, null);
    assert.equal(t.p, null);
  }
  assert.equal(r.table[0]!.pNote, "ZERO_MSE_NO_VARIATION");
  for (const c of r.comparisonsA) assert.equal(c.rawP, null);
});

test("rejects missing cell, unequal replicates, non-finite, n<2", () => {
  assert.throws(() => anova(A, B, [[[1, 2], []], [[3, 4], [5, 6]]]), (e: AppError) => e.code === "MISSING_CELL");
  assert.throws(() => anova(A, B, [[[1, 2], [3, 4, 5]], [[6, 7], [8, 9]]]), (e: AppError) => e.code === "UNEQUAL_REPLICATES");
  assert.throws(() => anova(A, B, [[[1, Number.NaN], [3, 4]], [[6, 7], [8, 9]]]), (e: AppError) => e.code === "NON_FINITE");
  assert.throws(() => anova(A, B, [[[1], [3]], [[6], [8]]]), (e: AppError) => e.code === "INSUFFICIENT_REPLICATES");
});

test("numerical stability under extreme scale", () => {
  // values around 1e12 with differences ~1; Kahan + centering keeps error SS finite and positive
  const base = 1e12;
  const d = [
    [[base, base + 1], [base + 10, base + 11]],
    [[base + 2, base + 3], [base + 12, base + 13]],
  ];
  const r = anova(A, B, d);
  const err = r.table.find((t) => t.source === "Error")!;
  assert.ok(err.ss > 0 && Number.isFinite(err.ss), "error SS must be finite positive");
  // within-cell deviations are +/-0.5 -> 8 * 0.25 = 2
  assert.ok(Math.abs(err.ss - 2) < 1e-3, `got ${err.ss}`);
});

test("distribution values match known critical points", () => {
  assert.ok(Math.abs(fSurvival(4.9646, 1, 10) - 0.05) < 1e-4);
  assert.ok(Math.abs(fSurvival(5.0959, 2, 12) - 0.025) < 1e-4);
  assert.ok(Math.abs(tTwoSided(2.2281, 10) - 0.05) < 1e-4);
  assert.ok(Math.abs(tTwoSided(1.96, 100000) - 0.05) < 1e-3);
  assert.ok(Math.abs(regularizedBeta(0, 2, 3)) < 1e-12);
  assert.ok(Math.abs(regularizedBeta(1, 2, 3) - 1) < 1e-12);
  assert.ok(fSurvival(1e9, 2, 10) < 1e-20);
});

test("Holm adjustment is monotone and traceable to raw p", () => {
  const r = anova(A, B, DATA);
  for (const comps of [r.comparisonsA, r.comparisonsB]) {
    for (const c of comps) {
      if (c.rawP !== null) {
        assert.ok(c.holmP! >= c.rawP - 1e-12);
        assert.ok(c.holmP! <= 1 + 1e-12);
      }
    }
  }
});
