// Independent known-answer tests against ISO/IEC 18004 tables.
// We re-derive the private internals by re-reading the source and eval'ing it as
// a module with extra exports appended -- no changes to the real file.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../web/js/qr.js', import.meta.url), 'utf8');
const extra = `
export const __t = { rsRemainder, formatBits, versionBits, alignmentCentres,
  blockDataLengths, EC_BLOCKS_M, encodeDataCodewords, interleaveCodewords,
  buildSkeleton, placementOrder, formatBitPositions, MASK_CONDITIONS, penaltyScore, gfMul };
`;
const url = 'data:text/javascript;base64,' + Buffer.from(src + extra).toString('base64');
const { __t: t } = await import(url);

let pass = 0, fail = 0;
const bad = [];
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; bad.push(`${name}\n    got  ${g}\n    want ${w}`); }
};

// ── 1. ISO Annex I.2: version 1-M, numeric "01234567" ─────────────────────
// Data codewords and the 10 EC codewords are printed verbatim in the standard.
const isoData = [0x10,0x20,0x0c,0x56,0x61,0x80,0xec,0x11,0xec,0x11,0xec,0x11,0xec,0x11,0xec,0x11];
const isoEc   = [0xa5,0x24,0xd4,0xc1,0xed,0x36,0xc7,0x87,0x2c,0x55];
check('RS(deg10) ISO Annex I.2 vector', Array.from(t.rsRemainder(isoData, 10)), isoEc);

// ── 2. Format information, ISO Table C.1, level M (indicator 00) ───────────
const ISO_FORMAT_M = [
  '101010000010010','101000100100101','101111001111100','101101101001011',
  '100010111111001','100000011001110','100111110010111','100101010100000',
];
for (let m = 0; m < 8; m += 1) {
  const bits = t.formatBits(m);
  const s = bits.toString(2).padStart(15, '0');       // bit14 .. bit0
  check(`format bits mask ${m}`, s, ISO_FORMAT_M[m]);
}

// ── 3. Version information, ISO Table D.1 ─────────────────────────────────
const ISO_VERSION = {
  7:'000111110010010100', 8:'001000010110111100',
  9:'001001101010011001', 10:'001010010011010011',
};
for (const v of [7,8,9,10]) {
  check(`version bits v${v}`, t.versionBits(v).toString(2).padStart(18,'0'), ISO_VERSION[v]);
}

// ── 4. Alignment pattern centres, ISO Table E.1 ───────────────────────────
const ISO_ALIGN = {
  1:[], 2:[6,18], 3:[6,22], 4:[6,26], 5:[6,30], 6:[6,34],
  7:[6,22,38], 8:[6,24,42], 9:[6,26,46], 10:[6,28,50],
};
for (let v = 1; v <= 10; v += 1) {
  check(`alignment centres v${v}`, t.alignmentCentres(v), ISO_ALIGN[v]);
}

// ── 5. Total codeword count per version, ISO Table 1 (all levels sum) ─────
// data+EC codewords must equal the version's total codeword count.
const ISO_TOTAL_CODEWORDS = {1:26,2:44,3:70,4:100,5:134,6:172,7:196,8:242,9:292,10:346};
for (let v = 1; v <= 10; v += 1) {
  const lens = t.blockDataLengths(v);
  const total = lens.reduce((a,b)=>a+b,0) + lens.length * t.EC_BLOCKS_M[v].ecPerBlock;
  check(`total codewords v${v}`, total, ISO_TOTAL_CODEWORDS[v]);
}

// ── 6. Module capacity vs codeword bits + remainder bits, ISO Table 1 ─────
const ISO_REMAINDER = {1:0,2:7,3:7,4:7,5:7,6:7,7:0,8:0,9:0,10:0};
for (let v = 1; v <= 10; v += 1) {
  const { size, reserved } = t.buildSkeleton(v);
  let free = 0;
  for (let r = 0; r < size; r += 1) for (let c = 0; c < size; c += 1) if (!reserved[r][c]) free += 1;
  check(`free data modules v${v}`, free, ISO_TOTAL_CODEWORDS[v]*8 + ISO_REMAINDER[v]);
}

console.log(`KNOWN-ANSWER TESTS: pass=${pass} fail=${fail}`);
if (bad.length) { console.log('FAILURES:'); for (const b of bad) console.log('  ' + b); }
