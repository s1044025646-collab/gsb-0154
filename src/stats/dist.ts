// Numerical distribution functions.
//
// All routines are self-contained (no external statistics services) and use
// the regularized incomplete beta function I_x(a,b) computed with the
// continued fraction from Numerical Recipes (Lentz's algorithm).
//
// Accuracy:
//  - logGamma: Lanczos (g=7, 9 coefficients), relative error < 1e-15.
//  - betacf: continued fraction iterated to a relative tolerance of 1e-15
//    (max 400 iterations); the incomplete beta / F / t CDFs are accurate to
//    roughly 1e-12 - 1e-14 over the ranges used here. Tail probabilities are
//    computed directly on whichever tail is smaller to avoid cancellation,
//    so very small p-values (1e-300) remain representable.

const EPS = 1e-15;
const MAX_ITERS = 400;

// Lanczos approximation for log Gamma.
export function logGamma(x: number): number {
  const cof = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x <= 0 && Number.isInteger(x)) return Infinity; // gamma pole
  if (x < 0.5) {
    // Reflection formula.
    return (
      Math.log(Math.PI / Math.sin(Math.PI * x)) -
      logGamma(1 - x)
    );
  }
  x -= 1;
  let tmp = x + 7.5;
  tmp = (x + 0.5) * Math.log(tmp) - tmp;
  let ser = cof[0]!;
  for (let i = 1; i < cof.length; i++) ser += cof[i]! / (x + i);
  return tmp + Math.log(ser * Math.SQRT2 * Math.sqrt(Math.PI));
}

function betaLog(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

// Modified Lentz continued fraction for the incomplete beta.
function betaCf(x: number, a: number, b: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  d = Math.abs(d) < 1e-300 ? 1e-300 : d;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITERS; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    d = Math.abs(d) < 1e-300 ? 1e-300 : d;
    c = 1 + aa / c;
    c = Math.abs(c) < 1e-300 ? 1e-300 : c;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    d = Math.abs(d) < 1e-300 ? 1e-300 : d;
    c = 1 + aa / c;
    c = Math.abs(c) < 1e-300 ? 1e-300 : c;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b), valid for 0<=x<=1, a,b>0. */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    a * Math.log(x) + b * Math.log1p(-x) - betaLog(a, b),
  );
  if (x < (a + 1) / (a + b + 2)) {
    return (bt * betaCf(x, a, b)) / a;
  }
  return 1 - (bt * betaCf(1 - x, b, a)) / b;
}

/** Upper-tail probability P(F_{df1,df2} >= f). f must be >= 0. */
export function fSurvival(f: number, df1: number, df2: number): number {
  if (!(f >= 0)) return NaN;
  if (f === 0) return 1;
  if (!Number.isFinite(f)) return 0;
  const x = df2 / (df2 + df1 * f);
  // P(F>=f) = I_{df2/(df2+df1 f)}(df2/2, df1/2)
  return regularizedBeta(x, df2 / 2, df1 / 2);
}

/** Two-sided Student t p-value with `df` degrees of freedom. */
export function tTwoSided(t: number, df: number): number {
  if (!Number.isFinite(df) || df <= 0) return NaN;
  const at = Math.abs(t);
  if (!Number.isFinite(at)) return 0;
  const x = df / (df + at * at);
  // two-sided = I_{df/(df+t^2)}(df/2, 1/2)
  return regularizedBeta(x, df / 2, 0.5);
}
