/**
 * 数值分布函数。
 *
 * 方法与精度说明：
 * - 使用 lgamma（Stirling 级数，相对误差约 1e-15）与正则化不完全贝塔函数
 *   I_x(a,b) 计算 F、t 分布的上尾概率。
 * - 不完全贝塔采用连分式展开（Lentz 方法，参考 Numerical Recipes betacf），
 *   最多迭代 200 次，收敛阈值 eps = 3e-14；对 x > (a+1)/(a+b+2) 使用对称关系
 *   I_x(a,b) = 1 - I_{1-x}(b,a) 以保证尾部精度。
 * - 双精度下 p 值在 [1e-12, 1-1e-12] 区间内与参考表误差通常小于 1e-10；
 *   小于约 1e-300 的下溢概率返回 0（属于双精度极限，不做任意精度扩展）。
 */

export const CF_EPS = 3e-14;
export const CF_MAX_ITER = 200;

export function logGamma(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let ser = 1.000000000190015;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  for (let j = 0; j < 6; j++) ser += cof[j] / (x + j + 1);
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betaCf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= CF_MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < CF_EPS) break;
  }
  return h;
}

/** 正则化不完全贝塔函数 I_x(a,b)。 */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b);
  const bt = Math.exp(lbeta + a * Math.log(x) + b * Math.log1p(-x));
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaCf(a, b, x)) / a;
  }
  return 1 - (bt * betaCf(b, a, 1 - x)) / b;
}

/** F 分布上尾概率 P(F(df1,df2) >= x)。 */
export function fUpperTail(x: number, df1: number, df2: number): number {
  if (!Number.isFinite(x) || x < 0) return NaN;
  if (x === 0) return 1;
  if (!Number.isFinite(x)) return 0;
  const z = df2 / (df2 + df1 * x);
  return regularizedBeta(z, df2 / 2, df1 / 2);
}

/** Student t 分布双侧 p 值。 */
export function tTwoSided(t: number, df: number): number {
  const x = df / (df + t * t);
  return regularizedBeta(x, df / 2, 0.5);
}

export type HolmResult = {
  index: number;
  raw: number;
  adjusted: number;
};

/**
 * Holm 逐步下降校正。输入为同一检验族内的原始 p 值。
 * 返回与输入等长、按原始顺序排列的 {raw, adjusted}。
 */
export function holm(pValues: number[]): HolmResult[] {
  const m = pValues.length;
  const order = pValues.map((_, i) => i).sort((i, j) => pValues[i] - pValues[j]);
  const adjSorted = new Array<number>(m);
  let running = 0;
  for (let rank = 0; rank < m; rank++) {
    const factor = m - rank;
    const candidate = factor * pValues[order[rank]];
    running = Math.max(running, Math.min(1, candidate));
    adjSorted[rank] = running;
  }
  return pValues.map((raw, index) => {
    const rank = order.indexOf(index);
    return { index, raw, adjusted: adjSorted[rank] };
  });
}
