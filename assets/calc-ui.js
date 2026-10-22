// Tubwise web calculators: page wiring. The maths lives in tubcalc.js (a port of the app's engine).
// Reads the page's strings from <script type="application/json" id="calc-i18n">, recomputes on
// every input, and writes the result into #res (aria-live). Nothing is stored or sent.
import * as C from './tubcalc.js';

const form = document.getElementById('calc-form');
const res = document.getElementById('res');
const T = JSON.parse(document.getElementById('calc-i18n').textContent);
document.getElementById('calc-nojs')?.remove();
res.hidden = false;

// ---- formatting ---------------------------------------------------------------------------------

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nf = (digits) => new Intl.NumberFormat(T.locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const num = (x, digits = 1) => nf(digits).format(x);
/** Template with {name} slots; values are inserted as bold text. Units keep a no-break space. */
const tpl = (s, vars = {}) => esc(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? `<b>${esc(vars[k])}</b>` : m)).replace(/(\d|\d<\/b>) (?=[\p{L}%°])/gu, '$1\u00a0');
const plural = (n, forms) => forms[new Intl.PluralRules(T.locale).select(n)] ?? forms.other;
const digitsFor = (x) => (x < 1 ? 2 : x < 100 ? 1 : 0);
const NB = ' ';

/** "13.5 g" / "0.48 oz (13.5 g)", "86 mL" / "2.9 fl oz (86 mL)", by the volume unit picked. */
function amount(x, liquid, gal) {
  const metric = `${num(x, digitsFor(x))}${NB}${liquid ? T.ml : T.g}`;
  if (!gal) return metric;
  const us = liquid ? C.mlToFluidOunces(x) : C.gramsToOunces(x);
  return `${num(us, us < 10 ? 2 : 1)}${NB}${liquid ? T.floz : T.oz} (${metric})`;
}

const ICON = {
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.5"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
  good: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
};
/** A status line: icon + label word + text, never colour alone. */
const flag = (kind, html) => `<p class="flag ${kind}">${ICON[kind]}<span><span class="sr">${esc(T.flags[kind])}: </span>${html}</span></p>`;

// ---- inputs -------------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const radio = (name) => form.querySelector(`input[name="${name}"]:checked`)?.value;
let touched = new Set();

function setError(id, msg) {
  const input = $(id), err = $(`${id}-err`);
  if (!input || !err) return;
  if (msg) { err.textContent = msg; err.hidden = false; input.setAttribute('aria-invalid', 'true'); }
  else { err.textContent = ''; err.hidden = true; input.removeAttribute('aria-invalid'); }
}

/** Reads a number field. Empty → null; bad or out of range → NaN with the error shown. */
function read(id, min, max) {
  const input = $(id);
  if (!input || input.closest('[hidden]')) return null;
  const raw = input.value.trim();
  if (!raw) { setError(id, ''); return null; }
  const v = C.parseNumber(raw, T.decimal);
  if (!Number.isFinite(v)) { setError(id, T.errNumber); return NaN; }
  if (v < min || v > max) { setError(id, tplText(T.errRange, { min: num(min, 2), max: num(max, 2) })); return NaN; }
  setError(id, '');
  return v;
}
const tplText = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

/** Volume in litres, or null/NaN. */
function volume() {
  const gal = $('vol-unit').value === 'gal';
  const k = gal ? C.LITRES_PER_US_GALLON : 1;
  const min = C.MIN_VOLUME_L / k, max = C.MAX_VOLUME_L / k;
  const v = read('vol', Math.floor(min * 10) / 10, Math.ceil(max));
  return { litres: Number.isFinite(v) ? v * k : v, gal, shown: v };
}

const show = (sel, on) => form.querySelectorAll(sel).forEach((el) => { el.hidden = !on; });
const empty = () => `<p class="muted">${esc(T.fillIn)}</p>`;
const retest = () => `<p class="muted">${esc(T.retest)}</p>`;

// ---- chlorine -----------------------------------------------------------------------------------

function chlorine() {
  const product = radio('product');
  show('[data-show="liquid"]', product === 'liquid');
  show('[data-show="calhypo"]', product === 'calhypo');
  const V = volume();
  const pct = product === 'liquid' ? read('liquid-pct', 1, 20) : product === 'calhypo' ? read('calhypo-pct', 30, 100) : 100;
  const fc = read('fc', 0, 20);
  const target = read('fc-target', 0, 20);
  const cc = read('cc', 0, 10);
  if ([V.litres, pct, fc, target].some((x) => x === null)) return empty();
  if ([V.litres, pct, fc, target, cc].some((x) => Number.isNaN(x))) return `<p class="muted">${esc(T.fixErrors)}</p>`;

  const prod = product === 'dichlor' ? C.dichlorDihydrate : product === 'calhypo' ? C.calHypo(pct) : C.liquidChlorine(pct);
  const name = T.products[product];
  const liquid = product === 'liquid';
  const eff = Math.min(target, C.MAX_SHOCK_FC);
  const out = [`<h3>${esc(T.doseH)}</h3>`];
  const plan = C.raiseFc({ volumeL: V.litres, current: fc, target: eff, product: prod });
  if (plan.issue === 'noChangeNeeded') {
    out.push(`<p class="res-what">${tpl(T.noneNeeded, { fc: num(fc), target: num(eff) })}</p>`);
  } else {
    out.push(`<p class="big">${amount(plan.firstAddition, liquid, V.gal)}</p>`);
    out.push(`<p class="res-what">${tpl(T.addProduct, { product: name })}</p>`);
    out.push(`<p>${tpl(T.raises, { from: num(fc), to: num(eff) })}</p>`);
    if (plan.sideEffects.cyanuricAcid) out.push(flag('info', tpl(T.cyaAdds, { x: num(plan.sideEffects.cyanuricAcid) })));
    if (plan.sideEffects.calciumHardness) out.push(flag('info', tpl(T.chAdds, { x: num(plan.sideEffects.calciumHardness) })));
  }
  if (target > C.MAX_SHOCK_FC) out.push(flag('warn', tpl(T.capped, { max: num(C.MAX_SHOCK_FC) })));
  const status = C.soakStatus(fc, { bandLow: C.FC_BAND_LOW, bandHigh: C.FC_BAND_HIGH, max: C.MAX_SHOCK_FC });
  if (status === 'doNotSoak') out.push(flag('stop', tpl(T.overMax, { max: num(C.MAX_SHOCK_FC) })));
  else if (plan.ok && eff > C.FC_BAND_HIGH) out.push(flag('warn', tpl(T.waitSoak, { top: num(C.FC_BAND_HIGH) })));
  else if (status === 'wait') out.push(flag('warn', tpl(T.waitSoak, { top: num(C.FC_BAND_HIGH) })));
  else if (status === 'ok' && !plan.ok) out.push(flag('good', esc(T.inBand)));

  if (cc !== null && cc > C.CC_SHOCK_THRESHOLD) {
    const sp = C.shockPlan({ cc });
    const shock = C.raiseFc({ volumeL: V.litres, current: fc, target: sp.targetFc, product: prod });
    out.push(`<h3>${esc(T.shockH)}</h3>`);
    if (shock.ok) {
      out.push(`<p class="big">${amount(shock.firstAddition, liquid, V.gal)}</p>`);
      out.push(`<p>${tpl(T.shock, { cc: num(cc, 2), target: num(sp.targetFc) })}</p>`);
    } else {
      out.push(`<p>${tpl(T.shockNone, { target: num(sp.targetFc) })}</p>`);
    }
    if (sp.capped) out.push(flag('warn', tpl(T.shockCapped, { bp: num(10 * cc), max: num(C.MAX_SHOCK_FC) })));
    out.push(flag('warn', tpl(T.waitSoak, { top: num(C.FC_BAND_HIGH) })));
  }
  out.push(`<p class="muted">${esc(liquid ? T.liquidTip : T.dryTip)}</p>`, retest());
  return out.join('');
}

// ---- pH and alkalinity --------------------------------------------------------------------------

function ph() {
  const V = volume();
  const now = read('ph', 6, 9), target = read('ph-target', 6.8, 8.6);
  const borate = read('borate', 0, 200) ?? 0;
  const down = !(Number.isFinite(now) && Number.isFinite(target) && target > now);
  show('[data-show="down"]', down);
  show('[data-show="up"]', !down);
  show('[data-show="muriatic"]', down && radio('acid') === 'muriatic');
  const murPct = down && radio('acid') === 'muriatic' ? read('mur-pct', 5, 36) : 31.45;
  const ta = read('ta', 0, 1000), taTarget = read('ta-target', 0, 300);
  const taPh = ta;
  const out = [];
  if (V.litres === null) return empty();
  if (Number.isNaN(V.litres)) return `<p class="muted">${esc(T.fixErrors)}</p>`;

  let phDosed = false, taDosed = false;
  // TA
  if ([ta, taTarget].some((x) => x === null)) {
    out.push(`<h3>${esc(T.taH0)}</h3>`, empty());
  } else if ([ta, taTarget].some((x) => Number.isNaN(x))) {
    out.push(`<h3>${esc(T.taH0)}</h3><p class="muted">${esc(T.fixErrors)}</p>`);
  } else {
    out.push(`<h3>${tpl(T.taH, { from: num(ta, 0), to: num(taTarget, 0) }).replace(/<\/?b>/g, '')}</h3>`);
    const plan = C.raiseTa({ volumeL: V.litres, current: ta, target: taTarget });
    if (plan.issue === 'noChangeNeeded') out.push(ta > taTarget ? flag('info', esc(T.taHigh)) : flag('good', esc(T.taAtTarget)));
    else {
      taDosed = true;
      const n = plan.steps.length;
      out.push(`<p class="big">${amount(plan.firstAddition, false, V.gal)}</p>`);
      out.push(`<p class="res-what">${tpl(n === 1 ? T.taAddNowOne : T.taAddNow, { pct: num(plan.shownFraction * 100, 0), n })}</p>`);
      if (n > 1) out.push(`<ol class="steps">${plan.steps.map((s, i) => `<li><span>${tpl(T.taStepTo, { i: i + 1, ta: num(ta + (plan.change * (i + 1)) / n, 0) })}</span><b>${esc(amount(s, false, V.gal))}</b></li>`).join('')}</ol>`);
      out.push(`<p class="muted">${esc(T.taRaisesPh)}</p>`);
    }
  }
  // pH
  if ([now, target, taPh].some((x) => x === null)) {
    out.push(`<h3>${esc(T.phH0)}</h3>`, empty());
  } else if ([now, target, taPh, borate, murPct].some((x) => Number.isNaN(x))) {
    out.push(`<h3>${esc(T.phH0)}</h3><p class="muted">${esc(T.fixErrors)}</p>`);
  } else {
    out.push(`<h3>${tpl(T.phH, { from: num(now, 2), to: num(target, 2) }).replace(/<\/?b>/g, '')}</h3>`);
    if (now === target) out.push(flag('good', esc(T.phAtTarget)));
    else {
      const lowering = target < now;
      const product = lowering ? (radio('acid') === 'muriatic' ? 'muriatic' : 'dry') : radio('base');
      const plan = lowering
        ? C.lowerPh({ volumeL: V.litres, from: now, to: target, ta: taPh, borate, acid: product === 'muriatic' ? C.Acid.muriatic(murPct) : C.Acid.dry() })
        : C.raisePh({ volumeL: V.litres, from: now, to: target, ta: taPh, borate, product: product === 'borax' ? C.PhUpProduct.boraxDecahydrate : C.PhUpProduct.sodiumCarbonate });
      if (plan.issue === 'outOfModelRange') out.push(flag('warn', esc(T.outOfModel)));
      else if (plan.ok && plan.steps.length) {
        phDosed = true;
        const liquid = plan.isLiquid;
        const targets = C.phStepTargets(now, target);
        out.push(`<p class="big">${amount(plan.firstAddition, liquid, V.gal)}</p>`);
        out.push(`<p class="res-what">${tpl(plan.steps.length === 1 ? T.addNowOne : T.addNow, { product: T.products[product], pct: num(plan.shownFraction * 100, 0), n: plan.steps.length })}</p>`);
        out.push(`<ol class="steps">${plan.steps.map((s, i) => `<li><span>${tpl(T.stepTo, { i: i + 1, ph: num(targets[i], 2) })}</span><b>${esc(amount(s, liquid, V.gal))}</b></li>`).join('')}</ol>`);
        if (lowering) out.push(`<p class="muted">${tpl(T.taDrop, { x: num(-plan.sideEffects.alkalinity) })}</p>`);
        else {
          out.push(`<p class="muted">${tpl(T.taRise, { x: num(plan.sideEffects.alkalinity) })}</p>`);
          if (plan.sideEffects.borates) out.push(`<p class="muted">${tpl(T.borateRise, { x: num(plan.sideEffects.borates) })}</p>`);
        }
        if (plan.taFloorReached) out.push(flag('warn', tpl(T.floor, { ph: num(now + plan.change, 2), floor: num(C.TA_FLOOR_PPM, 0) })));
      } else if (plan.taFloorReached) {
        out.push(flag('warn', tpl(T.floor, { ph: num(now, 2), floor: num(C.TA_FLOOR_PPM, 0) })));
      }
      if (lowering) out.push(`<p class="muted">${esc(T.acidTip)}</p>`);
    }
  }
  if (phDosed && taDosed) out.push(flag('info', esc(T.order)));
  if (phDosed || taDosed) out.push(retest());
  return out.join('');
}

// ---- drain --------------------------------------------------------------------------------------

function drain() {
  const V = volume();
  const people = read('people', 0, 20), soaks = read('soaks', 0, 42);
  const tdsFill = read('tds-fill', 0, 20000), tds = read('tds', 0, 20000);
  const fillEl = $('fill');
  const fill = fillEl.value ? new Date(`${fillEl.value}T12:00:00`) : null;
  if ([V.litres, people, soaks].some((x) => x === null)) return empty();
  if ([V.litres, people, soaks, tdsFill, tds].some((x) => Number.isNaN(x))) return `<p class="muted">${esc(T.fixErrors)}</p>`;
  const b = C.bathersPerDay({ soaksPerWeek: soaks, people });
  const days = C.drainIntervalDays({ volumeL: V.litres, bathersPerDay: b });
  const raw = C.wriDaysUsRule({ volumeL: V.litres, bathersPerDay: b });
  const out = [`<h3>${esc(T.drainH)}</h3>`];
  out.push(`<p class="big">${num(days, 0)} <small>${esc(plural(days, T.days))}</small></p>`);
  out.push(`<p class="res-what">${esc(T.everyLabel)}</p>`);
  if (raw !== null) {
    out.push(`<p class="muted">${tpl(T.formula, { gal: num(C.litresToGallons(V.litres), 0), b: num(b, 2), raw: num(raw, 1) })}</p>`);
  }
  if (raw === null || raw >= C.MAX_INTERVAL_DAYS) out.push(flag('info', tpl(T.capped90, { max: num(C.MAX_INTERVAL_DAYS, 0) })));
  if (fill && !Number.isNaN(fill.getTime())) {
    const today = new Date();
    const next = C.nextDrain({ fillDate: fill, intervalDays: days, today, tds: tds ?? null, fillTds: tdsFill ?? null });
    const n = C.daysUntil(next.date, today);
    const date = new Intl.DateTimeFormat(T.locale, { dateStyle: 'long' }).format(next.date);
    out.push(`<h3>${esc(T.nextH)}</h3><p class="big">${esc(date)}</p>`);
    const when = n > 0 ? tpl(T.inDays, { n: num(n, 0), unit: plural(n, T.days) }) : n === 0 ? esc(T.today) : tpl(T.overdue, { n: num(-n, 0), unit: plural(-n, T.days) });
    out.push(`<p class="res-what">${when}</p>`);
  }
  if (tds !== null && tdsFill !== null) {
    const rise = tds - tdsFill;
    out.push(C.tdsDrainDue({ tds, fillTds: tdsFill })
      ? flag('stop', tpl(T.tdsDue, { x: num(rise, 0), limit: num(C.TDS_DRAIN_RISE, 0) }))
      : flag('good', tpl(T.tdsOk, { x: num(Math.max(0, rise), 0), limit: num(C.TDS_DRAIN_RISE, 0) })));
  }
  const metric = C.wriDaysMetricRule({ volumeL: V.litres, bathersPerDay: b });
  if (metric !== null && metric < C.MAX_INTERVAL_DAYS && raw < C.MAX_INTERVAL_DAYS) out.push(`<p class="muted">${tpl(T.metricRule, { days: num(Math.floor(metric), 0) })}</p>`);
  return out.join('');
}

// ---- bromine ------------------------------------------------------------------------------------

let lastBr = 'cl';
function bromine() {
  const from = lastBr, to = from === 'cl' ? 'br' : 'cl';
  const v = read(from, 0, 100);
  if (v === null || Number.isNaN(v)) { if (v === null) $(to).value = ''; return Number.isNaN(v) ? `<p class="muted">${esc(T.fixErrors)}</p>` : empty(); }
  setError(to, '');
  const other = from === 'cl' ? C.chlorineToBromine(v) : C.bromineToChlorine(v);
  $(to).value = num(other, 2);
  const cl = from === 'cl' ? v : other, br = from === 'cl' ? other : v;
  return `<h3>${esc(T.resultH)}</h3><p class="big">${num(br, 2)} <small>${esc(T.brUnit)}</small></p>
<p class="res-what">${tpl(T.equals, { cl: num(cl, 2), br: num(br, 2) })}</p>
${flag('info', esc(T.bands))}`;
}

// ---- run ----------------------------------------------------------------------------------------

const RUN = { chlorine, ph, drain, bromine };
const kind = form.dataset.calc;
function update(e) {
  if (e?.target?.id) touched.add(e.target.id);
  if (kind === 'bromine' && (e?.target?.id === 'cl' || e?.target?.id === 'br')) lastBr = e.target.id;
  res.innerHTML = RUN[kind]();
}
form.addEventListener('input', update);
form.addEventListener('change', update);
form.addEventListener('submit', (e) => e.preventDefault());
update();
