/**
 * CommuteIQ — QR Code encoder, written from the ISO/IEC 18004 specification.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * PRD Feature 3 promises "a single unified QR code" for a multi-leg journey, and
 * server/api/pass.js issues the signed token that goes inside it. Something has
 * to turn that token into an actual symbol a phone camera can read, and there is
 * no `qrcode` package available — this prototype is deliberately dependency-free
 * and the registry is unreachable. So the encoder is implemented here in full:
 * Galois field arithmetic, Reed-Solomon, block interleaving, module placement,
 * format/version BCH codes and mask selection.
 *
 * Scope is narrowed on purpose, to the smallest slice that covers the feature:
 *
 *   - BYTE MODE ONLY. The pass token is `CIQ:PSS_xxxxxxxxxx:<exp36>:<sig>` —
 *     mixed case and colons, so alphanumeric mode cannot represent it and the
 *     numeric/kanji modes are irrelevant. One mode means one code path.
 *   - LEVEL M. Roughly 15% recovery. L is too fragile for a paper or screen pass
 *     held up in a moving vehicle; Q and H would push the same 44-character token
 *     to a denser symbol for no gain a phone camera needs.
 *   - VERSIONS 1-10. Version 10 holds 213 bytes at level M, about five times the
 *     token length, which leaves ample headroom without dragging in the whole
 *     version table. Anything longer than that does not belong in a QR code.
 *
 * ── Why there is a decoder in here ─────────────────────────────────────────
 * An encoder that is subtly wrong still produces a plausible-looking square of
 * black and white blocks. You cannot eyeball a bad interleave or an off-by-one in
 * the zig-zag placement, and we have no scanner in CI. `decodeQr` therefore walks
 * the whole pipeline backwards — recover the mask from the format bits, unmask,
 * re-read the zig-zag, de-interleave the blocks, strip the padding — so the test
 * suite can assert `decodeQr(encodeQr(s)) === s`. It exists to prove the encoder,
 * not to read photographs: it does no error correction and assumes an undamaged
 * matrix, because a round-trip that leaned on error correction would happily hide
 * the very bugs it is meant to catch.
 *
 * This module is loaded by the browser but must also run under plain Node for
 * that test, so nothing here touches the DOM at import time. `renderToCanvas` is
 * the single function that expects a document.
 */

// ── GF(256) arithmetic ──────────────────────────────────────────────────────

/**
 * The primitive polynomial QR uses, x^8 + x^4 + x^3 + x^2 + 1. Fixed by the
 * specification; every QR generator polynomial is derived over this field.
 */
const GF_PRIMITIVE = 0x11d;

/**
 * Antilog and log tables for the field. Multiplication in GF(256) is addition of
 * logarithms, and building the tables once turns every Reed-Solomon multiply into
 * two lookups. The antilog table is doubled to 512 entries so an index sum of up
 * to 508 needs no modulo at the call site.
 */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= GF_PRIMITIVE;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}

/** Product of two field elements. Zero has no logarithm, hence the guard. */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

// ── Reed-Solomon ────────────────────────────────────────────────────────────

/** Generator polynomials are reused across blocks, so cache them by degree. */
const GENERATOR_CACHE = new Map();

/**
 * Generator polynomial for `degree` error-correction codewords: the expansion of
 * (x - a^0)(x - a^1)...(x - a^(degree-1)). Coefficients are highest power first,
 * and the leading one is always 1.
 * @param {number} degree number of EC codewords
 * @returns {Uint8Array}
 */
function rsGenerator(degree) {
  const cached = GENERATOR_CACHE.get(degree);
  if (cached) return cached;

  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    // Multiply by (x + a^i); subtraction and addition are both XOR here.
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  const out = Uint8Array.from(poly);
  GENERATOR_CACHE.set(degree, out);
  return out;
}

/**
 * Error-correction codewords for one data block: the remainder of the data
 * polynomial shifted up by `degree` and divided by the generator.
 * @param {number[]|Uint8Array} data data codewords of one block
 * @param {number} degree number of EC codewords to produce
 * @returns {Uint8Array}
 */
function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Uint8Array(degree);

  for (const byte of data) {
    // Long division, one term at a time. `factor` is the current leading
    // coefficient; the generator is monic so it drops out of the top slot.
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let i = 0; i < degree; i += 1) {
      rem[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return rem;
}

// ── Version and block tables ────────────────────────────────────────────────

/** Lowest version this module emits. */
export const MIN_VERSION = 1;
/** Highest version this module emits; 213 bytes at level M. */
export const MAX_VERSION = 10;
/** The only error-correction level implemented here. */
export const EC_LEVEL = 'M';

/**
 * Block structure at level M, from the specification's table of EC
 * characteristics. `groups` lists [blockCount, dataCodewordsPerBlock] pairs;
 * versions 8-10 split into two groups whose block sizes differ by one codeword.
 */
const EC_BLOCKS_M = {
  1: { ecPerBlock: 10, groups: [[1, 16]] },
  2: { ecPerBlock: 16, groups: [[1, 28]] },
  3: { ecPerBlock: 26, groups: [[1, 44]] },
  4: { ecPerBlock: 18, groups: [[2, 32]] },
  5: { ecPerBlock: 24, groups: [[2, 43]] },
  6: { ecPerBlock: 16, groups: [[4, 27]] },
  7: { ecPerBlock: 18, groups: [[4, 31]] },
  8: { ecPerBlock: 22, groups: [[2, 38], [2, 39]] },
  9: { ecPerBlock: 22, groups: [[3, 36], [2, 37]] },
  10: { ecPerBlock: 26, groups: [[4, 43], [1, 44]] },
};

/** Byte mode's mode indicator. */
const MODE_BYTE = 0b0100;

/**
 * Data codewords per block, expanded to one entry per block and in the order the
 * interleaver expects. Both the encoder and the decoder derive their block layout
 * from this one function, so they cannot disagree.
 * @param {number} version
 * @returns {number[]}
 */
function blockDataLengths(version) {
  const lengths = [];
  for (const [count, len] of EC_BLOCKS_M[version].groups) {
    for (let i = 0; i < count; i += 1) lengths.push(len);
  }
  return lengths;
}

/** Total data codewords available at a version, level M. */
function dataCodewordCount(version) {
  return blockDataLengths(version).reduce((sum, n) => sum + n, 0);
}

/**
 * Width of the character count indicator. Byte mode uses 8 bits up to version 9
 * and 16 bits from version 10, which is why choosing a version and encoding the
 * header are not independent steps.
 */
function countIndicatorBits(version) {
  return version >= 10 ? 16 : 8;
}

/**
 * How many payload bytes fit at a given version. Derived rather than tabulated —
 * a second hardcoded table is a second thing that can disagree with the first.
 * @param {number} version
 * @returns {number}
 */
export function byteCapacity(version) {
  const bits = dataCodewordCount(version) * 8 - 4 - countIndicatorBits(version);
  return Math.floor(bits / 8);
}

/**
 * Centre coordinates of the alignment patterns. The first is always at 6; the
 * last sits 7 modules from the edge and the rest step back from it by an even
 * spacing, which is the construction the specification's table encodes.
 * @param {number} version
 * @returns {number[]}
 */
function alignmentCentres(version) {
  if (version === 1) return [];
  const size = 4 * version + 17;
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;

  const centres = new Array(count);
  centres[0] = 6;
  for (let i = count - 1, pos = size - 7; i >= 1; i -= 1, pos -= step) centres[i] = pos;
  return centres;
}

// ── BCH codes for the format and version information ────────────────────────

const FORMAT_GENERATOR = 0x537;
const FORMAT_MASK = 0x5412;
const VERSION_GENERATOR = 0x1f25;

/**
 * Remainder of `value` * x^checkBits divided by `generator` over GF(2). Both the
 * format BCH(15,5) and the version BCH(18,6) are this same operation at different
 * widths, so they share one routine.
 */
function bchRemainder(value, generator, checkBits) {
  let rem = value;
  for (let i = 0; i < checkBits; i += 1) {
    rem = (rem << 1) ^ (((rem >>> (checkBits - 1)) & 1) * generator);
  }
  return rem;
}

/**
 * The 15-bit format information for level M and a given mask. The final XOR with
 * 0x5412 is what stops an all-zero format field — level M with mask 0 — from
 * looking like blank space to a scanner.
 * @param {number} maskIndex 0-7
 * @returns {number} 15-bit value, bit 0 is the LSB
 */
function formatBits(maskIndex) {
  // Level M's two-bit code is 00, so the five data bits are just the mask.
  const data = maskIndex & 0b111;
  return ((data << 10) | bchRemainder(data, FORMAT_GENERATOR, 10)) ^ FORMAT_MASK;
}

/** The 18-bit version information, only present from version 7 upwards. */
function versionBits(version) {
  return (version << 12) | bchRemainder(version, VERSION_GENERATOR, 12);
}

/**
 * Module coordinates for each format information bit, indexed by bit position
 * with 0 as the least significant. The two copies are listed separately because
 * their layouts share no arithmetic, and both the encoder and the decoder read
 * this same list so a placement mistake cannot cancel itself out.
 * @param {number} size
 * @returns {{first: Array<[number, number]>, second: Array<[number, number]>}}
 */
function formatBitPositions(size) {
  const first = [];
  // Column 8 downwards, skipping the timing module at row 6.
  for (let i = 0; i <= 5; i += 1) first.push([i, 8]);
  first.push([7, 8]);
  first.push([8, 8]);
  first.push([8, 7]);
  // Then row 8 leftwards, again skipping the timing module at column 6.
  for (let i = 9; i < 15; i += 1) first.push([8, 14 - i]);

  const second = [];
  for (let i = 0; i < 8; i += 1) second.push([8, size - 1 - i]);
  for (let i = 8; i < 15; i += 1) second.push([size - 15 + i, 8]);

  return { first, second };
}

// ── The eight data masks ────────────────────────────────────────────────────

/**
 * Mask conditions from the specification, indexed by mask number. Each returns
 * true where the module should be inverted.
 */
const MASK_CONDITIONS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// ── Matrix skeleton ─────────────────────────────────────────────────────────

/**
 * Build the function patterns for a version: finders and separators, timing
 * patterns, alignment patterns, the dark module and the version information. The
 * format information region is reserved but left blank, because its contents
 * depend on which mask we end up choosing.
 *
 * `reserved` marks every module the data stream must skip. The decoder rebuilds
 * it from the version alone, which is the whole reason the two directions stay in
 * step.
 *
 * @param {number} version
 * @returns {{size: number, modules: boolean[][], reserved: boolean[][]}}
 */
function buildSkeleton(version) {
  const size = 4 * version + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunction = (row, col, dark) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    modules[row][col] = dark;
    reserved[row][col] = true;
  };

  // Timing patterns are drawn across the full width and height first; the finder
  // patterns and separators below overwrite the ends of them. Drawing in this
  // order is simpler than trying to clip the timing runs.
  for (let i = 0; i < size; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // Finder patterns with their separators. Measured in the Chebyshev distance
  // from the centre, a finder is dark at rings 0, 1 and 3, light at ring 2, and
  // ring 4 is the separator — so one predicate covers the pattern and its border.
  for (const [centreRow, centreCol] of [[3, 3], [3, size - 4], [size - 4, 3]]) {
    for (let dr = -4; dr <= 4; dr += 1) {
      for (let dc = -4; dc <= 4; dc += 1) {
        const ring = Math.max(Math.abs(dr), Math.abs(dc));
        setFunction(centreRow + dr, centreCol + dc, ring !== 2 && ring !== 4);
      }
    }
  }

  // Alignment patterns at every pairing of centres, except the three that would
  // sit on top of a finder pattern.
  const centres = alignmentCentres(version);
  const last = centres.length - 1;
  for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j <= last; j += 1) {
      const onFinder = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          setFunction(centres[i] + dr, centres[j] + dc, ring !== 1);
        }
      }
    }
  }

  // The dark module, always set, immediately above the lower-left format field.
  setFunction(size - 8, 8, true);

  // Reserve both format copies. Values are written after mask selection.
  const { first, second } = formatBitPositions(size);
  for (const [row, col] of [...first, ...second]) setFunction(row, col, false);

  // Version information, from version 7. Two copies, one the transpose of the
  // other, sitting beside the top-right and bottom-left finders.
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((bits >>> i) & 1) === 1;
      const far = size - 11 + (i % 3);
      const near = Math.floor(i / 3);
      setFunction(near, far, bit);
      setFunction(far, near, bit);
    }
  }

  return { size, modules, reserved };
}

/**
 * The zig-zag order in which codeword bits occupy the matrix: two-module columns
 * from the right edge leftwards, alternating upwards and downwards, with the
 * vertical timing column skipped entirely. Yields every coordinate including
 * reserved ones; callers filter.
 * @param {number} size
 */
function* placementOrder(size) {
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern. Shifting the pair one to the left
    // keeps the remaining columns paired correctly all the way to the edge.
    if (right === 6) right = 5;
    for (let v = 0; v < size; v += 1) {
      const row = upward ? size - 1 - v : v;
      yield [row, right];
      yield [row, right - 1];
    }
    upward = !upward;
  }
}

// ── Penalty scoring ─────────────────────────────────────────────────────────

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** The 1:1:3:1:1 finder-like sequence plus its four-module light margin. */
const FINDER_LIKE = [true, false, true, true, true, false, true, false, false, false, false];

/** N1: five or more same-coloured modules in a line, penalised per extra module. */
function runPenalty(at, size) {
  let score = 0;
  let run = 1;
  for (let i = 1; i < size; i += 1) {
    if (at(i) === at(i - 1)) {
      run += 1;
      if (run === 5) score += PENALTY_N1;
      else if (run > 5) score += 1;
    } else {
      run = 1;
    }
  }
  return score;
}

/**
 * N3: a run that mimics a finder pattern, in either orientation. Modules beyond
 * the symbol count as light, which is what lets the rule catch a false finder
 * sitting flush against the quiet zone.
 */
function finderLikePenalty(at, size) {
  const get = (i) => (i >= 0 && i < size ? at(i) : false);
  let score = 0;
  for (let start = -4; start <= size - 7; start += 1) {
    let forward = true;
    let backward = true;
    for (let k = 0; k < 11; k += 1) {
      const value = get(start + k);
      if (value !== FINDER_LIKE[k]) forward = false;
      if (value !== FINDER_LIKE[10 - k]) backward = false;
      if (!forward && !backward) break;
    }
    if (forward || backward) score += PENALTY_N3;
  }
  return score;
}

/**
 * Total penalty for a masked matrix. Lower is better: the four rules together
 * push the encoder away from symbols a scanner would struggle to lock onto.
 * @param {boolean[][]} modules
 * @returns {number}
 */
function penaltyScore(modules) {
  const size = modules.length;
  let score = 0;

  for (let i = 0; i < size; i += 1) {
    const row = (k) => modules[i][k];
    const col = (k) => modules[k][i];
    score += runPenalty(row, size) + runPenalty(col, size);
    score += finderLikePenalty(row, size) + finderLikePenalty(col, size);
  }

  // N2: every 2x2 block of one colour.
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        score += PENALTY_N2;
      }
    }
  }

  // N4: departure from an even split of dark and light, in 5% steps.
  let dark = 0;
  for (const row of modules) {
    for (const m of row) if (m) dark += 1;
  }
  const pct = (dark * 100) / (size * size);
  score += PENALTY_N4 * Math.floor(Math.abs(pct - 50) / 5);

  return score;
}

// ── Data encoding ───────────────────────────────────────────────────────────

/**
 * Latin-1 bytes of a string, rejecting anything that will not survive the trip.
 * Byte mode is defined over 8-bit values, so a character above 0xFF would be
 * silently truncated — better to refuse it than to hand back a QR code that
 * decodes to something the caller did not write.
 */
function toLatin1Bytes(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      throw new RangeError(`text must be ASCII/Latin-1; code point ${code} at index ${i} is not`);
    }
    bytes[i] = code;
  }
  return bytes;
}

/**
 * Header, payload, terminator and padding, assembled into exactly the version's
 * data codeword count.
 *
 * The two pad codewords 0xEC and 0x11 are prescribed by the specification. They
 * alternate rather than repeat because a long identical run would look like a
 * structural pattern to the mask penalty rules.
 *
 * @param {Uint8Array} bytes payload
 * @param {number} version
 * @returns {Uint8Array} data codewords
 */
function encodeDataCodewords(bytes, version) {
  const total = dataCodewordCount(version);
  const capacityBits = total * 8;
  const out = new Uint8Array(total);
  let pos = 0;

  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i -= 1) {
      if (pos >= capacityBits) throw new Error('bit overflow while encoding');
      if ((value >>> i) & 1) out[pos >>> 3] |= 0x80 >>> (pos & 7);
      pos += 1;
    }
  };

  push(MODE_BYTE, 4);
  push(bytes.length, countIndicatorBits(version));
  for (const byte of bytes) push(byte, 8);

  // Terminator: four zero bits, truncated if the symbol is already full.
  pos = Math.min(pos + 4, capacityBits);
  // Then zeroes up to the codeword boundary. The buffer starts zeroed, so both
  // of these are a cursor move rather than a write.
  if (pos % 8 !== 0) pos += 8 - (pos % 8);

  const pad = [0xec, 0x11];
  for (let i = 0; pos < capacityBits; i += 1) push(pad[i % 2], 8);

  return out;
}

/**
 * Split data codewords into EC blocks, compute each block's Reed-Solomon
 * remainder, then interleave. Interleaving is what makes level M useful against
 * real damage: a scratch that destroys a contiguous strip of the symbol is spread
 * across all the blocks instead of wiping out one of them entirely.
 * @param {Uint8Array} dataCodewords
 * @param {number} version
 * @returns {Uint8Array} the final codeword sequence, data then EC
 */
function interleaveCodewords(dataCodewords, version) {
  const { ecPerBlock } = EC_BLOCKS_M[version];
  const lengths = blockDataLengths(version);

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (const len of lengths) {
    const block = dataCodewords.subarray(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, ecPerBlock));
  }

  const out = new Uint8Array(dataCodewords.length + ecBlocks.length * ecPerBlock);
  let pos = 0;
  const longest = Math.max(...lengths);
  for (let i = 0; i < longest; i += 1) {
    for (const block of dataBlocks) if (i < block.length) out[pos++] = block[i];
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of ecBlocks) out[pos++] = block[i];
  }
  return out;
}

// ── Public encoder ──────────────────────────────────────────────────────────

/**
 * Encode a string as a QR code at error-correction level M.
 *
 * The smallest version from 1 to 10 that holds the payload is chosen. Remainder
 * bits — the few module positions past the last codeword on versions 2 to 6 —
 * are left light, which is what the specification asks for and also means the
 * decoder can simply stop reading once it has the codewords it expects.
 *
 * @param {string} text ASCII/Latin-1 payload, up to 213 characters
 * @returns {{size: number, modules: boolean[][], version: number, ecLevel: 'M'}}
 */
export function encodeQr(text) {
  const bytes = toLatin1Bytes(text);

  let version = 0;
  for (let v = MIN_VERSION; v <= MAX_VERSION; v += 1) {
    if (bytes.length <= byteCapacity(v)) { version = v; break; }
  }
  if (version === 0) {
    throw new RangeError(
      `payload of ${bytes.length} bytes exceeds ${byteCapacity(MAX_VERSION)} bytes, `
      + `the level M byte-mode capacity of version ${MAX_VERSION}`,
    );
  }

  const codewords = interleaveCodewords(encodeDataCodewords(bytes, version), version);
  const { size, modules: base, reserved } = buildSkeleton(version);

  // Lay the codeword bits down the zig-zag, unmasked.
  let bit = 0;
  const totalBits = codewords.length * 8;
  for (const [row, col] of placementOrder(size)) {
    if (reserved[row][col]) continue;
    if (bit < totalBits) {
      base[row][col] = ((codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1) === 1;
    }
    bit += 1;
  }

  // Try all eight masks and keep the least penalised. Format information is
  // written before scoring because it is part of the symbol a scanner sees.
  const { first, second } = formatBitPositions(size);
  let best = null;
  for (let maskIndex = 0; maskIndex < 8; maskIndex += 1) {
    const condition = MASK_CONDITIONS[maskIndex];
    const candidate = base.map((row) => row.slice());
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (!reserved[r][c] && condition(r, c)) candidate[r][c] = !candidate[r][c];
      }
    }
    const bits = formatBits(maskIndex);
    for (const positions of [first, second]) {
      for (let i = 0; i < 15; i += 1) {
        const [r, c] = positions[i];
        candidate[r][c] = ((bits >>> i) & 1) === 1;
      }
    }
    const score = penaltyScore(candidate);
    if (best === null || score < best.score) best = { score, modules: candidate };
  }

  return { size, modules: best.modules, version, ecLevel: EC_LEVEL };
}

// ── Decoder, for self-verification only ─────────────────────────────────────

/**
 * Read a QR code produced by `encodeQr` back into its payload.
 *
 * This is a verification tool, not a scanner. It assumes an intact matrix and
 * performs no error correction — deliberately, since a decoder that could repair
 * damage would also repair the encoder's own mistakes and report success on a
 * broken symbol. It does reverse every stage the encoder ran, including reading
 * the mask number out of the format information rather than being told it, so a
 * mistake in format placement or in the BCH code surfaces here too.
 *
 * @param {{size?: number, modules: boolean[][], version?: number}} symbol
 * @returns {string} the original payload
 */
export function decodeQr({ size, modules, version } = {}) {
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new TypeError('modules must be a non-empty array of rows');
  }
  const width = size ?? modules.length;
  if (modules.length !== width || modules.some((row) => !Array.isArray(row) || row.length !== width)) {
    throw new TypeError(`modules must be a ${width}x${width} matrix`);
  }
  const v = version ?? (width - 17) / 4;
  if (!Number.isInteger(v) || v < MIN_VERSION || v > MAX_VERSION || 4 * v + 17 !== width) {
    throw new RangeError(`version ${v} is not consistent with a size of ${width}`);
  }

  // Recover the mask from the first format copy, and check its BCH code so a
  // corrupted format field is reported rather than silently mis-unmasked.
  const { first } = formatBitPositions(width);
  let raw = 0;
  for (let i = 0; i < 15; i += 1) {
    const [r, c] = first[i];
    if (modules[r][c]) raw |= 1 << i;
  }
  const unmasked = raw ^ FORMAT_MASK;
  const formatData = unmasked >>> 10;
  if (((formatData << 10) | bchRemainder(formatData, FORMAT_GENERATOR, 10)) !== unmasked) {
    throw new Error('format information failed its BCH check');
  }
  if ((formatData >>> 3) !== 0) throw new Error('symbol is not error-correction level M');
  const condition = MASK_CONDITIONS[formatData & 0b111];

  // Re-walk the zig-zag, unmasking as we go. Only the data codewords are needed;
  // the EC codewords that follow them are ignored.
  const { reserved } = buildSkeleton(v);
  const lengths = blockDataLengths(v);
  const totalData = lengths.reduce((sum, n) => sum + n, 0);
  const interleaved = new Uint8Array(totalData);
  let bit = 0;
  const wanted = totalData * 8;
  for (const [row, col] of placementOrder(width)) {
    if (reserved[row][col]) continue;
    if (bit >= wanted) break;
    if (modules[row][col] !== condition(row, col)) interleaved[bit >>> 3] |= 0x80 >>> (bit & 7);
    bit += 1;
  }
  if (bit < wanted) throw new Error('matrix holds fewer data modules than the version requires');

  // De-interleave: the encoder emitted one codeword per block per round, so read
  // the stream back in the same rounds.
  const blocks = lengths.map((len) => new Uint8Array(len));
  const longest = Math.max(...lengths);
  let pos = 0;
  for (let i = 0; i < longest; i += 1) {
    for (let b = 0; b < blocks.length; b += 1) {
      if (i < lengths[b]) blocks[b][i] = interleaved[pos++];
    }
  }
  const codewords = new Uint8Array(totalData);
  let at = 0;
  for (const block of blocks) { codewords.set(block, at); at += block.length; }

  // Header, then payload. Padding beyond the character count is simply not read.
  let cursor = 0;
  const read = (widthBits) => {
    let value = 0;
    for (let i = 0; i < widthBits; i += 1) {
      value = (value << 1) | ((codewords[cursor >>> 3] >>> (7 - (cursor & 7))) & 1);
      cursor += 1;
    }
    return value;
  };

  const mode = read(4);
  if (mode !== MODE_BYTE) throw new Error(`expected byte mode, found mode indicator ${mode}`);
  const count = read(countIndicatorBits(v));
  if (count > byteCapacity(v)) throw new Error(`character count ${count} exceeds the version capacity`);

  let out = '';
  for (let i = 0; i < count; i += 1) out += String.fromCharCode(read(8));
  return out;
}

// ── Rendering ───────────────────────────────────────────────────────────────

/**
 * An SVG path `d` attribute covering every dark module.
 *
 * Horizontally adjacent modules are merged into one rectangle. That is not
 * cosmetic: a per-module path on a version 10 symbol runs to a few thousand
 * subpaths, and merging keeps the markup small enough to inline in a page without
 * a second thought. The path is drawn in module units scaled by `moduleSize`,
 * with no quiet zone — the caller adds that through the viewBox, so the same path
 * works at any margin.
 *
 * @param {boolean[][]} modules
 * @param {number} [moduleSize] side length of one module in user units
 * @returns {string}
 */
export function toSvgPath(modules, moduleSize = 1) {
  const s = Number(moduleSize);
  if (!Number.isFinite(s) || s <= 0) throw new RangeError('moduleSize must be a positive number');
  if (!Array.isArray(modules)) throw new TypeError('modules must be an array of rows');

  const trim = (n) => String(Math.round(n * 1000) / 1000);
  const parts = [];
  for (let r = 0; r < modules.length; r += 1) {
    const row = modules[r];
    let c = 0;
    while (c < row.length) {
      if (!row[c]) { c += 1; continue; }
      let run = 1;
      while (c + run < row.length && row[c + run]) run += 1;
      parts.push(
        `M${trim(c * s)} ${trim(r * s)}h${trim(run * s)}v${trim(s)}h-${trim(run * s)}z`,
      );
      c += run;
    }
  }
  return parts.join('');
}

/**
 * Paint a symbol onto a canvas. The only function here that expects a DOM.
 *
 * The default four-module quiet zone is the specification's minimum, and it is
 * not optional in practice: without it a phone camera cannot find the symbol's
 * edge against whatever is behind it on screen.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {boolean[][]} modules
 * @param {{moduleSize?: number, margin?: number, dark?: string, light?: string}} [options]
 * @returns {void}
 */
export function renderToCanvas(canvas, modules, options = {}) {
  const { moduleSize = 6, margin = 4, dark = '#0b1220', light = '#ffffff' } = options;
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new TypeError('canvas must be a canvas element');
  }
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new TypeError('modules must be a non-empty array of rows');
  }
  if (!Number.isFinite(moduleSize) || moduleSize <= 0) {
    throw new RangeError('moduleSize must be a positive number');
  }
  if (!Number.isInteger(margin) || margin < 0) {
    throw new RangeError('margin must be a non-negative whole number of modules');
  }

  const count = modules.length;
  const side = (count + margin * 2) * moduleSize;
  canvas.width = side;
  canvas.height = side;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('could not obtain a 2d context from the canvas');

  ctx.fillStyle = light;
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = dark;

  // Fill by horizontal run rather than by module: far fewer fillRect calls, and
  // it avoids the hairline seams that show up between separately drawn squares at
  // fractional device pixel ratios.
  for (let r = 0; r < count; r += 1) {
    const row = modules[r];
    let c = 0;
    while (c < row.length) {
      if (!row[c]) { c += 1; continue; }
      let run = 1;
      while (c + run < row.length && row[c + run]) run += 1;
      ctx.fillRect(
        (c + margin) * moduleSize,
        (r + margin) * moduleSize,
        run * moduleSize,
        moduleSize,
      );
      c += run;
    }
  }
}
