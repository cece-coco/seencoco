#!/usr/bin/env node
/*
 * assemble.js — the coherence engine for the seencoco SFW funnel.
 *
 * Turns 772 wardrobe items x 140 locations x 74 SFW poses x 55 angles into a
 * SHOT SPEC that looks like a person who made a decision that morning, rather
 * than a random draw (which reliably produces a ballgown in a hardware store).
 *
 * The mechanism is the REGISTER (registers.json): a bundle that constrains
 * location, slot pools, pose, angle and expression so they agree with each
 * other. Slot pools are TAG FILTERS resolved against the live catalog at
 * assemble time, so new wardrobe items are picked up with no code change.
 *
 * Everything here is SFW by construction. never_public slots (underwear, bra,
 * collar) are hard-cleared on every emit — the funnel layer has to survive
 * platform moderation, and exposure belongs behind the wall, not in the feed.
 *
 * usage:
 *   node assemble.js                      # one shot spec, printed
 *   node assemble.js --n 12               # twelve, as a batch manifest
 *   node assemble.js --register desk-2am  # force a register
 *   node assemble.js --seed 42            # deterministic
 *   node assemble.js --emit               # write outfit json + manifest to out/
 *
 * Emits nothing to the live house state. Outfit files land in engine/out/ and
 * are consumed by run.js via the CECE_OUTFIT env var.
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const CECE = path.resolve(HERE, '..', '..', '..');
const OUT = path.join(HERE, 'out');
const LEDGER = path.join(HERE, 'ledger.jsonl');

// ---- deterministic rng (mulberry32) so --seed reproduces a batch exactly
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const chance = (r, p) => r() < p;

function weightedPick(r, items) {
  const total = items.reduce((s, i) => s + (i.weight || 1), 0);
  let x = r() * total;
  for (const i of items) { x -= (i.weight || 1); if (x <= 0) return i; }
  return items[items.length - 1];
}

// ---- catalog access -------------------------------------------------------
function loadCatalog() {
  const raw = JSON.parse(fs.readFileSync(path.join(CECE, 'wardrobe', 'catalog.json'), 'utf8'));
  const items = raw.items || raw;
  return (Array.isArray(items) ? items : Object.values(items)).filter(i => i && i.id);
}

function loadPoses() {
  const raw = JSON.parse(fs.readFileSync(path.join(CECE, 'wardrobe', 'poses.json'), 'utf8'));
  const poses = raw.poses || raw;
  return (Array.isArray(poses) ? poses : Object.values(poses))
    .filter(p => p && p.id)
    // hard SFW gate: never sample anything flagged nsfw or tagged as such
    .filter(p => !p.nsfw && !/nsfw|explicit/i.test((p.tags || []).join(',')))
    // couple-* poses bring a second person into the frame; the funnel is solo
    .filter(p => !/^couple-/.test(p.id) && !(p.tags || []).includes('1boy'));
}

function loadAngles() {
  const raw = JSON.parse(fs.readFileSync(path.join(CECE, 'wardrobe', 'angles.json'), 'utf8'));
  const angles = raw.angles || raw;
  return (Array.isArray(angles) ? angles : Object.values(angles)).filter(a => a && (a.id || typeof a === 'string'))
    .map(a => (typeof a === 'string' ? { id: a } : a));
}

// ---- matching -------------------------------------------------------------
// A slot pool is a list of tag substrings. An item qualifies if any of its
// tags, its name, or its id contains any of the filters. Deliberately loose:
// the catalog's vocabulary drifts, and a near-miss beats an empty pool.
function matchItems(items, slot, filters) {
  // `slot` is a comma-string on older catalog entries and an ARRAY on newer ones.
  // v1 assumed the string and threw on every array. Same bug class as the dollhouse
  // queries that didn't SELECT the column the logic read: code asserting a shape the
  // data does not have. Handle both, cheaply.
  const slotsOf = (i) => (Array.isArray(i.slot) ? i.slot : String(i.slot || '').split(','))
    .map((s) => String(s).trim()).filter(Boolean);
  const inSlot = items.filter(i => slotsOf(i).includes(slot));
  if (!filters || !filters.length) return inSlot;
  const hay = i => [...(i.tags || []), i.name || '', i.id || ''].join(' ').toLowerCase();
  const hits = inSlot.filter(i => filters.some(f => hay(i).includes(f.toLowerCase())));
  return hits.length ? hits : inSlot; // fail soft to the whole slot
}

function matchPose(poses, tags) {
  if (!tags || !tags.length) return poses;
  const hay = p => [...(p.tags || []), p.name || '', p.id || ''].join(' ').toLowerCase();
  const hits = poses.filter(p => tags.some(t => hay(p).includes(t.toLowerCase())));
  return hits.length ? hits : poses;
}

function matchAngle(angles, wanted) {
  if (!wanted || !wanted.length) return angles;
  const ids = new Set(angles.map(a => a.id));
  const exact = wanted.filter(w => ids.has(w));
  if (exact.length) return exact.map(id => ({ id }));
  // fuzzy: "cowboy-shot" -> anything containing "cowboy"
  const hits = angles.filter(a => wanted.some(w => a.id.includes(w.split('-')[0])));
  return hits.length ? hits : angles;
}

// ---- assembly -------------------------------------------------------------
function assembleOne(r, cfg, cat, poses, angles, forceRegister) {
  const reg = forceRegister
    ? cfg.registers.find(x => x.id === forceRegister)
    : weightedPick(r, cfg.registers);
  if (!reg) throw new Error(`unknown register "${forceRegister}"`);

  const optional = new Set(reg.optional || []);
  const slots = {};
  const chosen = {};

  // exclusivity: if the register offers a dress, it wins and top/bottom clear.
  const wantsDress = !!reg.slots.dress;

  for (const [slot, filters] of Object.entries(reg.slots)) {
    if (wantsDress && (slot === 'top' || slot === 'bottom')) continue;
    if (optional.has(slot) && !chance(r, 0.55)) continue;
    const pool = matchItems(cat, slot, filters);
    if (!pool.length) continue;
    const item = pick(r, pool);
    chosen[slot] = item;
    // jewelry + accessories are array slots in the live schema
    slots[slot] = (slot === 'jewelry' || slot === 'accessories')
      ? [{ item: item.id }]
      : { item: item.id };
  }

  // always-on slots
  for (const slot of (cfg.rules.always || [])) {
    if (slots[slot]) continue;
    const pool = matchItems(cat, slot, null);
    if (pool.length) { const it = pick(r, pool); chosen[slot] = it; slots[slot] = { item: it.id }; }
  }

  // hard gate — the funnel layer is clothed, always.
  //
  // ...except clearing the layer UNDER an open one produces MORE exposure, not
  // less. Found 2026-07-26 by looking at an actual render: the gym shot's top was
  // `shirt-25` ("flannel worn open over a tank", tags include "open clothes"), the
  // gate dutifully cleared `bra` to none, and the result was an open flannel over
  // nothing — on content headed for a public feed. A rule that cannot see context
  // did the exact opposite of its job. Same species as the 07-23 render bug where
  // naming a piercing tag SUMMONED the layer it named.
  //
  // wardrobe-tags.js already knows this ("only a CLOSED one hides it. Open shirt
  // over a bra is a real, intentional look") but its closureOf() closes over local
  // state and isn't exportable. The shared thing here is the ATTRIBUTE, not the
  // logic — so read the same marker off the catalog rather than import a rule.
  const OPEN_RE = /\bopen\b|unbuttoned|unzipped|cardigan/i;
  const isOpen = (it) => !!it && (it.closure === 'open'
    || (it.tags || []).some((t) => OPEN_RE.test(t))
    || OPEN_RE.test(it.name || ''));
  const outerIsOpen = isOpen(chosen.top) || isOpen(chosen.dress);

  for (const slot of (cfg.rules.never_public || [])) {
    // keep the bra when nothing closed is covering it — that IS the modest answer
    if (slot === 'bra' && outerIsOpen) continue;
    slots[slot] = { item: 'none' };
  }
  if (wantsDress) { slots.top = { item: 'none' }; slots.bottom = { item: 'none' }; }

  const pose = pick(r, matchPose(poses, reg.pose_tags));
  const angle = pick(r, matchAngle(angles, reg.angles));
  const ex = reg.expression || {};

  return {
    register: reg.id,
    register_name: reg.name,
    location: pick(r, reg.locations),
    pose: pose.id,
    pose_name: pose.name,
    angle: angle.id,
    eyes: ex.eyes ? pick(r, ex.eyes) : null,
    mouth: ex.mouth ? pick(r, ex.mouth) : null,
    gaze: ex.gaze ? pick(r, ex.gaze) : null,
    caption_register: reg.caption_register,
    worn: Object.fromEntries(Object.entries(chosen).map(([s, i]) => [s, i.name])),
    outfit: { resident: 'cece', slots }
  };
}

// ---- cli ------------------------------------------------------------------
function main() {
  const argv = process.argv.slice(2);
  const flag = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] || true) : d; };
  const has = k => argv.includes('--' + k);

  const n = parseInt(flag('n', '1'), 10);
  const seed = parseInt(flag('seed', String(Date.now() % 2147483647)), 10);
  const forceRegister = flag('register', null);
  const emit = has('emit');

  const cfg = JSON.parse(fs.readFileSync(path.join(HERE, 'registers.json'), 'utf8'));
  const cat = loadCatalog();
  const poses = loadPoses();
  const angles = loadAngles();
  const r = rng(seed);

  const shots = [];
  for (let i = 0; i < n; i++) shots.push(assembleOne(r, cfg, cat, poses, angles, forceRegister));

  if (emit) {
    fs.mkdirSync(OUT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    shots.forEach((s, i) => {
      const p = path.join(OUT, `${stamp}-${String(i).padStart(3, '0')}-${s.register}.outfit.json`);
      fs.writeFileSync(p, JSON.stringify(s.outfit, null, 2));
      s.outfit_path = p;
      fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), seed, ...s, outfit: undefined }) + '\n');
    });
    const man = path.join(OUT, `${stamp}-manifest.json`);
    fs.writeFileSync(man, JSON.stringify({ seed, count: shots.length, shots }, null, 2));
    console.log(`[assemble] ${shots.length} shot(s) -> ${OUT}`);
    console.log(`[assemble] manifest: ${man}`);
  }

  for (const s of shots) {
    console.log(`\n── ${s.register_name}  (${s.register})`);
    console.log(`   location : ${s.location}`);
    console.log(`   pose     : ${s.pose}  — ${s.pose_name}`);
    console.log(`   angle    : ${s.angle}`);
    console.log(`   face     : eyes=${s.eyes} mouth=${s.mouth} gaze=${s.gaze}`);
    console.log(`   wearing  : ${Object.entries(s.worn).map(([k, v]) => `${k}=${v}`).join(' · ') || '(nothing resolved)'}`);
  }
  console.log(`\n[assemble] seed=${seed}  (reuse with --seed ${seed})`);
}

if (require.main === module) main();
module.exports = { assembleOne, loadCatalog, loadPoses, loadAngles, rng };
