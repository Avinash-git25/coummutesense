import { readFileSync } from 'node:fs';
import { encodeQr, toSvgPath, renderToCanvas } from '../web/js/qr.js';

// ---- A. the silent-success shape bug, both renderers ----
console.log('A. malformed rows -> silent success?');
console.log('   toSvgPath([1,2])            ->', JSON.stringify(toSvgPath([1, 2], 1)));
console.log('   toSvgPath(["ab","cd"])      ->', JSON.stringify(toSvgPath(['ab', 'cd'], 1)));
console.log('   toSvgPath([null,null])      ->', (() => { try { return JSON.stringify(toSvgPath([null, null], 1)); } catch (e) { return 'THREW ' + e.constructor.name; } })());
function stub() { const c = []; return { width: 0, height: 0, _c: c, getContext: (k) => k === '2d' ? { fillStyle: '', fillRect: (x, y, w, h) => c.push([x, y, w, h]) } : null }; }
{ const cv = stub();
  let r; try { renderToCanvas(cv, [1, 2, 3]); r = `returned normally, ${cv._c.length} fillRect calls, canvas ${cv.width}x${cv.height}`; }
  catch (e) { r = 'THREW ' + e.constructor.name + ': ' + e.message; }
  console.log('   renderToCanvas(cv,[1,2,3])  ->', r); }
{ const cv = stub();
  let r; try { renderToCanvas(cv, ['xx', 'yy']); r = `returned normally, ${cv._c.length} fillRect calls`; }
  catch (e) { r = 'THREW ' + e.constructor.name; }
  console.log('   renderToCanvas(cv,["xx"])   ->', r); }
{ const cv = stub();
  let r; try { renderToCanvas(cv, [null]); r = `returned normally, ${cv._c.length} fillRect calls`; }
  catch (e) { r = 'THREW ' + e.constructor.name; }
  console.log('   renderToCanvas(cv,[null])   ->', r); }

// ---- B. mask selection must be a true argmin over all 8 ----
const src = readFileSync(new URL('../web/js/qr.js', import.meta.url), 'utf8');
const extra = `
export const __t = { buildSkeleton, placementOrder, formatBitPositions, MASK_CONDITIONS,
  penaltyScore, formatBits, encodeDataCodewords, interleaveCodewords, runPenalty,
  finderLikePenalty, PENALTY_N1, PENALTY_N2, PENALTY_N3, PENALTY_N4 };
`;
const { __t: t } = await import('data:text/javascript;base64,' + Buffer.from(src + extra).toString('base64'));

function scoresFor(text) {
  const { modules: base, reserved, size } = (() => {
    const bytes = new Uint8Array([...text].map((c) => c.charCodeAt(0)));
    let v = 0; for (let i = 1; i <= 10; i++) { if (bytes.length <= (t.__cap ?? (() => 0))()) break; }
    return null;
  })() ?? {};
  return null;
}

// Re-derive the 8 candidate scores the encoder would have computed, then confirm
// the emitted matrix equals the lowest-scoring candidate.
function candidates(text) {
  const sym = encodeQr(text);
  const { size, version } = sym;
  const { modules: base, reserved } = t.buildSkeleton(version);
  // rebuild the unmasked data layer exactly as encodeQr does
  const cw = t.interleaveCodewords(t.encodeDataCodewords(
    new Uint8Array([...text].map((c) => c.charCodeAt(0))), version), version);
  let bit = 0; const total = cw.length * 8;
  for (const [r, c] of t.placementOrder(size)) {
    if (reserved[r][c]) continue;
    if (bit < total) base[r][c] = ((cw[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
    bit += 1;
  }
  const { first, second } = t.formatBitPositions(size);
  const out = [];
  for (let mi = 0; mi < 8; mi++) {
    const cond = t.MASK_CONDITIONS[mi];
    const cand = base.map((r) => r.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
      if (!reserved[r][c] && cond(r, c)) cand[r][c] = !cand[r][c];
    const fb = t.formatBits(mi);
    for (const pos of [first, second]) for (let i = 0; i < 15; i++) {
      const [r, c] = pos[i]; cand[r][c] = ((fb >>> i) & 1) === 1;
    }
    out.push({ mi, score: t.penaltyScore(cand), cand });
  }
  return { sym, out };
}

console.log('\nB. mask selection is a true argmin:');
let argminOk = 0, argminBad = 0;
const samples = ['', 'CIQ:PSS_0123456789:kx7z1a:0123456789abcdef', 'a', 'a'.repeat(50),
  'x'.repeat(213), '0'.repeat(120), 'CommuteIQ SIH 2026 PS 26205 pass token test string here'];
for (const s of samples) {
  const { sym, out } = candidates(s);
  const min = Math.min(...out.map((o) => o.score));
  const chosen = out.find((o) => JSON.stringify(o.cand) === JSON.stringify(sym.modules));
  const okMin = chosen && chosen.score === min;
  if (okMin) argminOk++; else argminBad++;
  console.log(`   len ${String(s.length).padStart(3)} v${sym.version}  scores [${out.map((o) => o.score).join(', ')}]  min=${min}  chosen=mask ${chosen ? chosen.mi : '??'} score ${chosen ? chosen.score : '??'}  ${okMin ? 'OK' : 'MISMATCH'}`);
}
console.log(`   argmin: ok=${argminOk} bad=${argminBad}`);

// ---- C. penalty rules against hand-computed values ----
console.log('\nC. penalty rules vs hand-computed:');
const mk = (rows) => rows.map((r) => [...r].map((ch) => ch === '#'));
// N1: a single row of 7 dark in a 7x7 all-light-except-row grid is hard to isolate,
// so test runPenalty directly on a 1-D line.
const line = (s) => { const a = [...s].map((ch) => ch === '#'); return [(i) => a[i], a.length]; };
const rp = (s) => { const [at, n] = line(s); return t.runPenalty(at, n); };
const cases = [
  ['....', 3],        // run of 4 light = 3? no: run of 4 -> 0. expect 0
  ['#####', 3],       // run of 5 -> N1 = 3
  ['######', 4],      // run of 6 -> 3+1
  ['#######', 5],     // run of 7 -> 3+2
  ['#####.....', 6],  // two runs of 5 -> 3+3
  ['#.#.#.#.#', 0],   // no run >= 5
];
for (const [s, want] of cases) {
  const got = rp(s);
  console.log(`   runPenalty(${s.padEnd(10)}) = ${got}  want ${want}  ${got === want ? 'OK' : 'MISMATCH'}`);
}
// N3: exact finder-like sequence
const fl = (s) => { const [at, n] = line(s); return t.finderLikePenalty(at, n); };
const n3 = [
  ['#.###.#....', 40],   // finder then 4 light  -> 40
  ['....#.###.#', 40],   // 4 light then finder  -> 40
  ['#.###.#', 40],       // finder flush to end; beyond-symbol counts light -> 40
  ['...........', 0],    // nothing
];
for (const [s, want] of n3) {
  const got = fl(s);
  console.log(`   finderLike(${s.padEnd(11)}) = ${got}  want ${want}  ${got === want ? 'OK' : 'MISMATCH'}`);
}
console.log(`   PENALTY_N1..N4 = ${t.PENALTY_N1}, ${t.PENALTY_N2}, ${t.PENALTY_N3}, ${t.PENALTY_N4}  (ISO: 3, 3, 40, 10)`);
