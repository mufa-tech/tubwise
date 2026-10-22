// Tubwise web calculators: the maths. A line-by-line port of the app's engine,
// packages/spa_chem/lib/src/{constants,safety,dosing,ph,drain_interval,units}.dart, so the site and
// the app give the same numbers. Specification and sources: research/chemistry.md.
// Tested against research/test-vectors.json by tools/site/calc.test.mjs (node --test).
//
// Canonical units, as in the engine: volume in litres; TA and CH in ppm as CaCO3; FC in ppm as Cl2;
// bromine in ppm as Br2; amounts in grams (dry) or millilitres (liquid).
// No DOM here: tools/site/static/calc-ui.js wires these functions to the pages.

// --- constants.dart ------------------------------------------------------------------------------

/** Molar masses, g/mol (IUPAC 2021 abridged atomic weights; hydrates include their water). */
export const MolarMass = Object.freeze({
  calcium: 40.078, // Ca
  calciumCarbonate: 100.087, // CaCO3
  sodiumBicarbonate: 84.007, // NaHCO3 (baking soda)
  sodiumCarbonate: 105.988, // Na2CO3 (soda ash)
  calciumChloride: 110.98, // CaCl2
  chlorine: 70.906, // Cl2: DPD kits report chlorine "as Cl2"
  bromine: 159.808, // Br2
  sodiumBisulfate: 120.06, // NaHSO4 (dry acid)
  cyanuricAcid: 129.07, // CYA
  dichlorDihydrate: 255.98, // sodium dichloroisocyanurate dihydrate
  boraxDecahydrate: 381.37, // Na2B4O7·10H2O
  boron: 10.81, // B
});

/** 1 US liquid gallon in litres (exact: 231 in³; NIST SP 811). */
export const LITRES_PER_US_GALLON = 3.785411784;
/** 1 US fluid ounce in mL (exact: 1/128 US gallon). */
export const ML_PER_US_FL_OZ = 29.5735295625;
/** 1 avoirdupois ounce in grams (exact). */
export const GRAMS_PER_OUNCE = 28.349523125;
/** 1 avoirdupois pound in grams (exact). */
export const GRAMS_PER_POUND = 453.59237;
/** 1 meq/L = 50.0435 ppm as CaCO3 (half the molar mass of CaCO3). */
export const PPM_CACO3_PER_MEQ = MolarMass.calciumCarbonate / 2;
/** Bromine ↔ chlorine reporting factor. Exact molar ratio 159.808 / 70.906 = 2.2538; Taylor's
 *  technical FAQ rounds it to 2.25, and so does the app, so numbers match the kit charts. */
export const BROMINE_CHLORINE_FACTOR = 2.25;

export const gallonsToLitres = (gal) => gal * LITRES_PER_US_GALLON;
export const litresToGallons = (l) => l / LITRES_PER_US_GALLON;
export const gramsToOunces = (g) => g / GRAMS_PER_OUNCE;
export const mlToFluidOunces = (ml) => ml / ML_PER_US_FL_OZ;
export const chlorineToBromine = (cl) => cl * BROMINE_CHLORINE_FACTOR;
export const bromineToChlorine = (br) => br / BROMINE_CHLORINE_FACTOR;

/** Volumes the site accepts (research/chemistry.md §1, valid input ranges). */
export const MIN_VOLUME_L = 50;
export const MAX_VOLUME_L = 60000;

// --- finite.dart ---------------------------------------------------------------------------------

/** A usable amount, volume, rise or strength: a real number > 0 (NaN and ±∞ rejected). */
export const isPositiveFinite = (x) => Number.isFinite(x) && x > 0;

// --- safety.dart ---------------------------------------------------------------------------------
// Sources: Lay-Z-Spa chemicals guide; SpaGuard; TFP Pool Math notes; PHTA ranges via Taylor's
// technical FAQ; CDC hot tub module (research/chemistry.md §13).

/** Largest TA rise per addition, ppm (SpaGuard rapid tabs: +30 per dose). */
export const MAX_TA_RISE_PER_ADDITION = 30;
/** Largest CH rise per addition, ppm. */
export const MAX_CH_RISE_PER_ADDITION = 50;
/** Largest pH move per addition. */
export const MAX_PH_STEP = 0.3;
/** Acid never takes TA below this, ppm. */
export const TA_FLOOR_PPM = 50;
/** Share of a computed balance dose (pH, TA, CH, acid) shown before a retest. */
export const BALANCE_DOSE_FRACTION = 0.75;
/** Share shown when the reading came from a strip. */
export const STRIP_DOSE_FRACTION = 0.5;
/** FC is never planned above this (PHTA spa maximum; CDC remediation level). */
export const MAX_SHOCK_FC = 10;
/** Combined chlorine above this calls for a shock (PHTA spa maximum). */
export const CC_SHOCK_THRESHOLD = 0.5;
/** Top of the FC soak band (PHTA ideal 3–5). */
export const FC_BAND_HIGH = 5;
export const FC_BAND_LOW = 3;

export function shownFractionFor({ balance, fromStrip = false }) {
  const f = balance ? BALANCE_DOSE_FRACTION : 1.0;
  return fromStrip ? Math.min(f, STRIP_DOSE_FRACTION) : f;
}

/** Additions needed so none moves the level by more than maxChange: at least 1. */
export function additionsFor(delta, maxChange) {
  if (Number.isNaN(maxChange)) throw new RangeError('maxChange must be a number');
  if (!(maxChange > 0) || maxChange === Infinity) return 1;
  // Epsilon so a rise exactly at the cap stays one addition.
  const ratio = Math.abs(delta) / maxChange - 1e-9;
  if (!(ratio < 1 << 20)) return 1 << 20;
  return Math.max(1, Math.ceil(ratio));
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** pH after each addition when moving from → to in steps of at most maxStep:
 *  8.2 → 7.5 gives [7.9, 7.6, 7.5]. Empty when there is nothing to move. */
export function phStepTargets(from, to, maxStep = MAX_PH_STEP) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(maxStep > 0) || from === to) return [];
  const n = additionsFor(to - from, maxStep);
  const dir = to > from ? 1 : -1;
  const out = [];
  for (let i = 1; i <= n; i++) out.push(i === n ? to : round6(from + dir * maxStep * i));
  return out;
}

/** Shock target for combined chlorine cc: FC = min(10, max(bandTop, 10 × CC)). Null when CC is at
 *  or below 0.5 or not a number. */
export function shockPlan({ cc, bandTop = FC_BAND_HIGH }) {
  if (!(cc > CC_SHOCK_THRESHOLD) || !Number.isFinite(cc)) return null;
  const want = Math.max(bandTop, 10 * cc);
  return { targetFc: Math.min(MAX_SHOCK_FC, want), capped: want > MAX_SHOCK_FC };
}

/** 'ok' inside the band, 'low' below it, 'wait' above it, 'doNotSoak' above the maximum. */
export function soakStatus(reading, { bandLow, bandHigh, max }) {
  if (!Number.isFinite(reading)) return 'doNotSoak';
  if (reading > max) return 'doNotSoak';
  if (reading > bandHigh + 1e-9) return 'wait';
  if (reading < bandLow - 1e-9) return 'low';
  return 'ok';
}

/** Minutes to circulate before a retest: 20 with jets on (hard shell), 4 h of filtering (inflatable). */
export const retestWaitMinutes = (shell) => (shell === 'inflatable' ? 240 : 20);

// --- dosing.dart: plans --------------------------------------------------------------------------

/**
 * A dose plan, as DosePlan in the engine.
 * issue: null | 'noChangeNeeded' | 'invalidVolume' | 'invalidProduct' | 'outOfModelRange'.
 * steps: amount (g or mL) of each addition; firstAddition = steps[0] × shownFraction.
 */
function plan({ param, change = 0, steps = [], isLiquid = false, shownFraction = 0, sideEffects = {}, issue = null, taFloorReached = false }) {
  const amount = steps.reduce((a, b) => a + b, 0);
  return Object.freeze({
    param, change, steps: Object.freeze([...steps]), isLiquid, shownFraction, sideEffects, issue, taFloorReached,
    ok: issue === null,
    amount,
    firstAddition: steps.length ? steps[0] * shownFraction : 0,
  });
}
const issuePlan = (param, issue, isLiquid = false) => plan({ param, issue, isLiquid });

function checkLevels(current, target) {
  if (!Number.isFinite(current)) throw new RangeError('current must be finite');
  if (!Number.isFinite(target)) throw new RangeError('target must be finite');
}

function equalSteps(total, delta, maxChange) {
  const n = additionsFor(delta, maxChange);
  return Array(n).fill(total / n);
}

// --- Total alkalinity up -------------------------------------------------------------------------

/** TA-up products: molar mass and equivalents of TA per mole. */
export const TaUpProduct = Object.freeze({
  sodiumBicarbonate: Object.freeze({ molarMass: MolarMass.sodiumBicarbonate, eqPerMol: 1 }),
  sodiumCarbonate: Object.freeze({ molarMass: MolarMass.sodiumCarbonate, eqPerMol: 2 }),
});

/** Grams per ppm (as CaCO3) per litre. */
export const gramsPerPpmLitre = (p) => p.molarMass / p.eqPerMol / PPM_CACO3_PER_MEQ / 1000;

/** Grams to raise TA from current to target: g = ΔTA / 50.0435 × V × M / eq / 1000 (§2a).
 *  Split into additions of ≤ 30 ppm; 75 % of the first is shown. */
export function raiseTa({ volumeL, current, target, product = TaUpProduct.sodiumBicarbonate, fromStrip = false }) {
  checkLevels(current, target);
  if (!isPositiveFinite(volumeL)) return issuePlan('alkalinity', 'invalidVolume');
  const delta = target - current;
  if (!(delta > 0)) return issuePlan('alkalinity', 'noChangeNeeded');
  const g = delta * volumeL * gramsPerPpmLitre(product);
  return plan({
    param: 'alkalinity', change: delta, steps: equalSteps(g, delta, MAX_TA_RISE_PER_ADDITION),
    isLiquid: false, shownFraction: shownFractionFor({ balance: true, fromStrip }),
  });
}

/** TA rise (ppm) from grams of product in volumeL. */
export const taRiseFrom = ({ grams, volumeL, product = TaUpProduct.sodiumBicarbonate }) =>
  isPositiveFinite(grams) && isPositiveFinite(volumeL) ? grams / volumeL / gramsPerPpmLitre(product) : 0;

// --- Chlorine ------------------------------------------------------------------------------------

/** Dichlor dihydrate: 2 × 70.906 / 255.98 = 55.40 % available chlorine; + 129.07 / 141.812
 *  = 0.910 ppm CYA per ppm FC (TFP Pool Math constant 4149.03; chemistry.md §5a). */
export const dichlorDihydrate = Object.freeze({
  kind: 'dry',
  availableFraction: (2 * MolarMass.chlorine) / MolarMass.dichlorDihydrate,
  sideEffectsPerPpm: Object.freeze({ cyanuricAcid: MolarMass.cyanuricAcid / (2 * MolarMass.chlorine) }),
});

/** Calcium hypochlorite at percent available chlorine (label, 65–73 %): + 100.087 / 141.812
 *  = 0.706 ppm CH per ppm FC. */
export const calHypo = (percent) => Object.freeze({
  kind: 'dry',
  availableFraction: percent / 100,
  sideEffectsPerPpm: Object.freeze({ calciumHardness: MolarMass.calciumCarbonate / (2 * MolarMass.chlorine) }),
});

/** Liquid chlorine (bleach, pool chlorine) at percent strength. TFP Pool Math density-aware model:
 *  ppm per (fl oz / US gal) k(p) = (75.71 p + 0.746 p²) × (p > 9 ? 1.02 − 0.008 p : 1); p ≤ 9 is
 *  weight % NaOCl, p > 9 is "trade %". ppm per mL/L = k / 7.8125. */
export const liquidChlorine = (percent) => Object.freeze({ kind: 'liquid', percent, sideEffectsPerPpm: Object.freeze({}) });

/** ppm FC added by 1 g (dry) or 1 mL (liquid) in 1 L. */
export function ppmPerUnitPerLitre(product) {
  if (product.kind === 'dry') return product.availableFraction * 1000;
  const p = product.percent;
  const k = (75.71 * p + 0.746 * p * p) * (p > 9 ? 1.02 - 0.008 * p : 1);
  return k / (ML_PER_US_FL_OZ / LITRES_PER_US_GALLON);
}

const usableChlorine = (p) => (p.kind === 'dry'
  ? p.availableFraction > 0 && p.availableFraction <= 1
  : p.percent > 0 && p.percent <= 20);

/** Amount of product to raise FC from current to target. One addition: sanitiser is dosed to the
 *  top of the band (engine: shownFraction 1). The page caps the target at MAX_SHOCK_FC. */
export function raiseFc({ volumeL, current, target, product }) {
  checkLevels(current, target);
  const liquid = product.kind === 'liquid';
  if (!isPositiveFinite(volumeL)) return issuePlan('freeChlorine', 'invalidVolume', liquid);
  if (!usableChlorine(product)) return issuePlan('freeChlorine', 'invalidProduct', liquid);
  const delta = target - current;
  if (!(delta > 0)) return issuePlan('freeChlorine', 'noChangeNeeded', liquid);
  const amount = (delta * volumeL) / ppmPerUnitPerLitre(product);
  const sideEffects = {};
  for (const [k, v] of Object.entries(product.sideEffectsPerPpm)) sideEffects[k] = v * delta;
  return plan({ param: 'freeChlorine', change: delta, steps: [amount], isLiquid: liquid, shownFraction: 1, sideEffects });
}

/** FC rise (ppm) from amount g or mL of product in volumeL. */
export const fcRiseFrom = ({ amount, volumeL, product }) =>
  isPositiveFinite(amount) && isPositiveFinite(volumeL) && usableChlorine(product)
    ? (amount * ppmPerUnitPerLitre(product)) / volumeL
    : 0;

// --- ph.dart -------------------------------------------------------------------------------------
// TroubleFreePool Pool Math CalcPH() (calc.html, J. T. Linhart 2007–2010, TFP 2013–2026), in meq:
//   p̄ = (pH_from + pH_to) / 2
//   adj = (192.1626 − 60.1221 p̄ + 6.0752 p̄² − 0.1943 p̄³) · (TA + 13.91) / 114.6
//   extra = −5.476259 + 2.414292 p̄ − 0.355882 p̄² + 0.01755 p̄³   (per ppm borate as B)
//   acid demand (meq/L) = ΔpH · (adj + extra · B) · 0.325469

const ACID_MEQ_FACTOR = 0.325469;
export const MODEL_PH_LOW = 7.0;
export const MODEL_PH_HIGH = 8.4;

const adj = (p, ta) => ((192.1626 - 60.1221 * p + 6.0752 * p * p - 0.1943 * p * p * p) * (ta + 13.91)) / 114.6;
const extra = (p) => -5.476259 + 2.414292 * p - 0.355882 * p * p + 0.01755 * p * p * p;

/** The TFP polynomial is fitted to pool pH; outside this window the engine refuses. */
export function inModel(from, to, ta, borate) {
  const p = (from + to) / 2;
  return from >= 6.8 && from <= 8.6 && to >= 6.8 && to <= 8.6 && p >= MODEL_PH_LOW && p <= MODEL_PH_HIGH &&
    ta >= 0 && ta <= 300 && borate >= 0 && borate <= 80;
}

const buffer = (from, to, ta, borate) => {
  const p = (from + to) / 2;
  return adj(p, ta) + extra(p) * borate;
};

const allFinite = (...xs) => xs.every((x) => Number.isFinite(x));

/** Acid demand (meq/L) for a one-go move from → to. Null outside the model or when to ≥ from. */
export function acidDemandMeq({ from, to, ta, borate = 0 }) {
  if (!allFinite(from, to, ta, borate)) return null;
  if (!(to < from) || !inModel(from, to, ta, borate)) return null;
  return (from - to) * buffer(from, to, ta, borate) * ACID_MEQ_FACTOR;
}

/** Acids and their strength in meq per mL (liquid) or per g (dry). */
export const Acid = Object.freeze({
  /** Muriatic acid at percent HCl: 31.45 % (20 °Bé) = 10.006 meq/mL; other strengths scale
   *  linearly (TFP multiplier table), which errs low for weak acid: the safe side. */
  muriatic: (percent) => Object.freeze({ meqPerUnit: (10.006 * percent) / 31.45, isLiquid: true }),
  /** Dry acid (sodium bisulfate) at purity % NaHSO4; 93.2 % is what TFP's constants imply. */
  dry: (purity = 93.2) => Object.freeze({ meqPerUnit: (purity / 100 / MolarMass.sodiumBisulfate) * 1000, isLiquid: false }),
});

/** Amount (mL or g) of acid for a one-go move, as TFP computes it (no split, no 75 % share). */
export function acidAmount({ volumeL, from, to, ta, acid, borate = 0 }) {
  const meq = acidDemandMeq({ from, to, ta, borate });
  if (meq === null || !isPositiveFinite(volumeL)) return null;
  return (meq * volumeL) / acid.meqPerUnit;
}

/** pH-up products: molar mass, TFP mmol factor, eq TA per mol, B per mol. */
export const PhUpProduct = Object.freeze({
  sodiumCarbonate: Object.freeze({ molarMass: MolarMass.sodiumCarbonate, mmolFactor: 0.32312, eqTa: 2, boron: 0 }),
  boraxDecahydrate: Object.freeze({ molarMass: MolarMass.boraxDecahydrate, mmolFactor: 0.17844, eqTa: 2, boron: 4 }),
});

/** Grams of product for a one-go pH rise (TFP form). */
export function phUpGrams({ volumeL, from, to, ta, product, borate = 0 }) {
  if (!allFinite(from, to, ta, borate)) return null;
  if (!(to > from) || !inModel(from, to, ta, borate)) return null;
  if (!isPositiveFinite(volumeL)) return null;
  const mmol = (to - from) * buffer(from, to, ta, borate) * product.mmolFactor;
  return (mmol * volumeL * product.molarMass) / 1000;
}

/** Plan to lower pH with acid: steps of ≤ 0.3 pH, each at its own mean pH; each step's TA drop is
 *  applied before the next; a step that would take TA under 50 ppm is cut short and flagged. */
export function lowerPh({ volumeL, from, to, ta, acid, borate = 0, fromStrip = false }) {
  if (!allFinite(from, to, ta, borate)) throw new RangeError('pH, TA and borate must be finite');
  if (!isPositiveFinite(volumeL)) return issuePlan('ph', 'invalidVolume', acid.isLiquid);
  if (!isPositiveFinite(acid.meqPerUnit)) return issuePlan('ph', 'invalidProduct', acid.isLiquid);
  if (!(to < from)) return issuePlan('ph', 'noChangeNeeded', acid.isLiquid);
  if (!inModel(from, to, ta, borate)) return issuePlan('ph', 'outOfModelRange', acid.isLiquid);
  const steps = [];
  let ph = from, taNow = ta, taDrop = 0, floor = false;
  for (const next of phStepTargets(from, to)) {
    let meq = (ph - next) * buffer(ph, next, taNow, borate) * ACID_MEQ_FACTOR;
    const room = (taNow - TA_FLOOR_PPM) / PPM_CACO3_PER_MEQ;
    if (meq > room) { floor = true; meq = room > 0 ? room : 0; }
    if (meq > 0) steps.push((meq * volumeL) / acid.meqPerUnit);
    taNow -= meq * PPM_CACO3_PER_MEQ;
    taDrop += meq * PPM_CACO3_PER_MEQ;
    ph = next;
    if (floor) break;
  }
  return plan({
    param: 'ph', change: floor ? ph - from : to - from, steps, isLiquid: acid.isLiquid,
    shownFraction: shownFractionFor({ balance: true, fromStrip }),
    sideEffects: { alkalinity: -taDrop }, taFloorReached: floor,
  });
}

/** Plan to raise pH with soda ash or borax, steps of ≤ 0.3 pH. */
export function raisePh({ volumeL, from, to, ta, product = PhUpProduct.sodiumCarbonate, borate = 0, fromStrip = false }) {
  if (!allFinite(from, to, ta, borate)) throw new RangeError('pH, TA and borate must be finite');
  if (!isPositiveFinite(volumeL)) return issuePlan('ph', 'invalidVolume');
  if (!(to > from)) return issuePlan('ph', 'noChangeNeeded');
  if (!inModel(from, to, ta, borate)) return issuePlan('ph', 'outOfModelRange');
  const steps = [];
  let ph = from, taNow = ta, b = borate, taRise = 0, bRise = 0;
  for (const next of phStepTargets(from, to)) {
    const mmol = (next - ph) * buffer(ph, next, taNow, b) * product.mmolFactor;
    steps.push((mmol * volumeL * product.molarMass) / 1000);
    const dTa = mmol * product.eqTa * PPM_CACO3_PER_MEQ;
    const dB = mmol * product.boron * MolarMass.boron;
    taNow += dTa; b += dB; taRise += dTa; bRise += dB;
    ph = next;
  }
  const sideEffects = { alkalinity: taRise };
  if (product.boron > 0) sideEffects.borates = bRise;
  return plan({
    param: 'ph', change: to - from, steps, isLiquid: false,
    shownFraction: shownFractionFor({ balance: true, fromStrip }), sideEffects,
  });
}

/** TA drop (ppm) from amount mL or g of acid in volumeL. */
export const taDropFromAcid = ({ amount, volumeL, acid }) =>
  isPositiveFinite(amount) && isPositiveFinite(volumeL) ? (amount * acid.meqPerUnit) / volumeL * PPM_CACO3_PER_MEQ : 0;

/** TA and borate rise from grams of a pH-up product. */
export function phUpEffect({ grams, volumeL, product }) {
  if (!isPositiveFinite(grams) || !isPositiveFinite(volumeL)) return { ta: 0, borate: 0 };
  const mmolPerL = (grams / product.molarMass) * 1000 / volumeL;
  return { ta: mmolPerL * product.eqTa * PPM_CACO3_PER_MEQ, borate: mmolPerL * product.boron * MolarMass.boron };
}

// --- drain_interval.dart -------------------------------------------------------------------------
// US rule: days = (gallons / 3) / average bathers per day (CDC hot tub module, citing MAHC).
// Metric (Ontario O. Reg. 428/05): V / (10 × U). Ceiling 90 days. TDS > fill + 1,500 → drain now.

export const MAX_INTERVAL_DAYS = 90;
export const TDS_DRAIN_RISE = 1500;

export const wriDaysUsRule = ({ volumeL, bathersPerDay }) =>
  isPositiveFinite(volumeL) && isPositiveFinite(bathersPerDay) ? volumeL / LITRES_PER_US_GALLON / 3 / bathersPerDay : null;

export const wriDaysMetricRule = ({ volumeL, bathersPerDay }) =>
  isPositiveFinite(volumeL) && isPositiveFinite(bathersPerDay) ? volumeL / (10 * bathersPerDay) : null;

/** Average bather uses per day from soaksPerWeek sessions with people in the tub each time. */
export const bathersPerDay = ({ soaksPerWeek, people }) =>
  isPositiveFinite(soaksPerWeek) && isPositiveFinite(people) ? (soaksPerWeek * people) / 7 : 0;

/** Whole days between drains by the US rule: rounded down, at least 1, at most 90. */
export function drainIntervalDays({ volumeL, bathersPerDay: b }) {
  if (!isPositiveFinite(volumeL)) throw new RangeError('volumeL must be a positive number');
  const days = wriDaysUsRule({ volumeL, bathersPerDay: b });
  if (days === null || !(days < MAX_INTERVAL_DAYS)) return MAX_INTERVAL_DAYS;
  return Math.max(1, Math.floor(days));
}

/** True when TDS is more than 1,500 mg/L over the fill water. */
export const tdsDrainDue = ({ tds, fillTds }) =>
  Number.isFinite(tds) && Number.isFinite(fillTds) && tds - fillTds > TDS_DRAIN_RISE;

const day = (t) => new Date(t.getFullYear(), t.getMonth(), t.getDate());

/** Next drain date: today when TDS is too high, else fill date + intervalDays (calendar days). */
export function nextDrain({ fillDate, intervalDays, today, tds = null, fillTds = null }) {
  if (tds !== null && fillTds !== null && tdsDrainDue({ tds, fillTds })) return { date: day(today), reason: 'tdsHigh' };
  const d = day(fillDate);
  return { date: new Date(d.getFullYear(), d.getMonth(), d.getDate() + intervalDays), reason: 'schedule' };
}

/** Whole calendar days from today to due; negative when overdue (noon-to-noon UTC, DST-proof). */
export function daysUntil(due, today) {
  const a = day(today), b = day(due);
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate(), 12);
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate(), 12);
  return Math.round((ub - ua) / 86400000);
}

// --- Input parsing (site only) -------------------------------------------------------------------

/**
 * Parses what a person types: "1,5" and "1.5", "1 500", "1.500" (comma-decimal languages) or
 * "1,500" (dot-decimal languages). decimal is the page language's decimal separator.
 * Returns NaN for anything that is not a plain number.
 */
export function parseNumber(text, decimal = '.') {
  let s = String(text ?? '').trim().replace(/[\s  ']/g, '').replace(/^\+/, '').replace(/−/g, '-');
  if (!s) return NaN;
  const group = decimal === ',' ? '.' : ',';
  const hasDot = s.includes('.'), hasComma = s.includes(',');
  if (hasDot && hasComma) {
    // The separator that comes last is the decimal one.
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
  } else if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ',';
    const grouped = new RegExp(`^-?\\d{1,3}(\\${sep}\\d{3})+$`).test(s);
    if (sep === group && grouped) s = s.split(sep).join('');
    else if ((s.match(new RegExp(`\\${sep}`, 'g')) || []).length > 1) return NaN;
    else s = s.replace(sep, '.');
  }
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
}
