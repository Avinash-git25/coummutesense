/**
 * QR codec — the hand-rolled encoder in web/js/qr.js.
 *
 * There is no `qrcode` package here and no scanner in CI, so the only thing that
 * can tell us the encoder is right is the encoder's own inverse. That makes
 * `decodeQr(encodeQr(s)) === s` the headline assertion of this file, run over the
 * shapes of payload the prototype actually issues plus the ones that push the
 * version selector around.
 *
 * A round trip alone is not proof, though — an encoder and a decoder can agree on
 * a mistake. So the geometry is asserted independently, against the specification
 * rather than against the other direction: the finder rings, the timing runs, the
 * alignment centres, the dark module, the size formula. Those are the parts a
 * round trip cannot see, because the decoder rebuilds the same skeleton from the
 * version and skips it — a wrong table there is an error both directions make
 * together, and only a literal comparison against ISO/IEC 18004 catches it.
 *
 * On error correction, read `describe('error correction')` below before believing
 * anything about it. The EC codewords are generated and written into the symbol,
 * but `decodeQr` deliberately never reads them, so this file does NOT claim
 * damage recovery. It pins the actual behaviour instead.
 *
 * Two things are knowingly NOT covered, both for the same reason — the decoder
 * stops reading at the character count, so nothing past it is observable without
 * reimplementing the zig-zag placement inside the test:
 *
 *   - The pad codeword values. The specification prescribes 0xEC and 0x11
 *     alternating; swapping them leaves every assertion in this file green. Any
 *     conforming decoder ignores padding, so the exposure is limited to a slight
 *     shift in mask penalty scoring.
 *   - The four terminator bits, likewise unread.
 *
 * `renderToCanvas` is untested here on purpose: it is the one export that needs a
 * DOM, and there is no document under node:test.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  EC_LEVEL,
  MAX_VERSION,
  MIN_VERSION,
  byteCapacity,
  decodeQr,
  encodeQr,
  toSvgPath,
} from '../web/js/qr.js';

/** The real thing: what server/api/pass.js signs and the phone has to scan. */
const PASS_TOKEN = 'CIQ:PSS_0123456789:mfk3l2:0a1b2c3d4e5f6071';

/** Encode, decode, assert we got the input back. Returns the symbol for reuse. */
function roundTrip(text, label = JSON.stringify(text).slice(0, 48)) {
  const symbol = encodeQr(text);
  assert.equal(decodeQr(symbol), text, `round trip lost ${label}`);
  return symbol;
}

/** Chebyshev distance from a centre — the ring index a finder is built from. */
const ring = (dr, dc) => Math.max(Math.abs(dr), Math.abs(dc));

/** Deep copy of a module matrix, so a flip cannot leak into another assertion. */
const copyModules = (modules) => modules.map((row) => row.slice());

/** A symbol with one module inverted. */
function withFlip(symbol, row, col) {
  const modules = copyModules(symbol.modules);
  modules[row][col] = !modules[row][col];
  return { size: symbol.size, modules, version: symbol.version };
}

/**
 * What a damaged symbol does when read back: recovered the text, returned
 * something else, or refused. Collapsing the three into one word is what lets the
 * error-correction tests below assert an outcome rather than a message.
 */
function readBack(symbol, text) {
  try {
    return decodeQr(symbol) === text ? 'INTACT' : 'CHANGED';
  } catch {
    return 'THREW';
  }
}

/** Count of horizontal dark runs — one SVG subpath each, computed independently. */
function darkRunCount(modules) {
  let runs = 0;
  for (const row of modules) {
    let c = 0;
    while (c < row.length) {
      if (!row[c]) { c += 1; continue; }
      runs += 1;
      while (c < row.length && row[c]) c += 1;
    }
  }
  return runs;
}

describe('round trip', () => {
  it('carries a real pass token there and back', () => {
    const symbol = roundTrip(PASS_TOKEN);
    // 43 characters lands in version 3 (capacity 42 at version 2, 42 < 43). If
    // this number moves, either a capacity table changed or the token format did.
    assert.equal(symbol.version, 3);
    assert.equal(symbol.ecLevel, EC_LEVEL);
    assert.equal(symbol.ecLevel, 'M');
  });

  it('handles the degenerate short payloads', () => {
    roundTrip('');
    roundTrip('A');
    roundTrip('hi');
  });

  it('survives every length that forces a version bump', () => {
    // 10 -> v1, 30 -> v3, 60 -> v4, 120 -> v7, 200 -> v10: one payload on each
    // side of most of the capacity steps, so a broken block layout at any version
    // shows up here rather than only on the version the demo happens to use.
    for (const len of [10, 30, 60, 120, 200]) {
      const text = 'CIQ:'.repeat(60).slice(0, len);
      assert.equal(text.length, len);
      roundTrip(text, `${len} chars`);
    }
  });

  it('does not care what the bytes spell', () => {
    roundTrip('0123456789'.repeat(4));                       // all digits
    roundTrip('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'); // all alpha
    roundTrip('PSS_9f3a Route 42 / Bay 7 (Andheri)');        // mixed
    roundTrip('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');         // punctuation only
  });

  it('carries bytes above 127, because byte mode is Latin-1 not ASCII', () => {
    // toLatin1Bytes accepts the full 0x00-0xFF range, so accented text in a stop
    // name is legal payload. 0xFF and 0x80 are the interesting ones: a decoder
    // that sign-extended or went through UTF-8 would mangle exactly these.
    roundTrip('Café Münster naïve ¾ ± ÿ');
    roundTrip(String.fromCharCode(0x80, 0xa0, 0xfe, 0xff));

    // And a code point that byte mode genuinely cannot hold is refused rather
    // than truncated — a silently truncated payload is a QR code that scans to
    // something the caller never wrote.
    assert.throws(() => encodeQr('₹120'), /Latin-1/);
    assert.throws(() => encodeQr('日本'), RangeError);
  });

  it('round trips a payload using every byte value, at full capacity', () => {
    // 213 distinct byte values, which is also the exact version 10 capacity: this
    // one string exercises the high bytes, the 16-bit count indicator, the
    // two-group block split at version 10 and the zero-padding path all at once.
    const text = Array.from({ length: 213 }, (_, i) => String.fromCharCode(i)).join('');
    const symbol = roundTrip(text, 'all byte values');
    assert.equal(symbol.version, 10);
  });

  it('reads a symbol back without being told its size or version', () => {
    // The browser stores only the module matrix in some paths, so the decoder has
    // to be able to infer the rest from the matrix width alone.
    const { modules } = encodeQr(PASS_TOKEN);
    assert.equal(decodeQr({ modules }), PASS_TOKEN);
    assert.equal(decodeQr({ modules, size: 29 }), PASS_TOKEN);
  });
});

describe('symbol geometry', () => {
  it('sizes every version as 17 + 4v, with a square matrix', () => {
    for (let v = MIN_VERSION; v <= MAX_VERSION; v += 1) {
      const symbol = encodeQr('x'.repeat(byteCapacity(v)));
      assert.equal(symbol.version, v);
      assert.equal(symbol.size, 17 + 4 * v);
      assert.equal(symbol.modules.length, symbol.size);
      for (const row of symbol.modules) assert.equal(row.length, symbol.size);

      // size*size modules, every one a boolean — never undefined from a row that
      // was allocated but not filled.
      const cells = symbol.modules.flat();
      assert.equal(cells.length, symbol.size * symbol.size);
      assert.ok(cells.every((m) => typeof m === 'boolean'), `v${v} has non-boolean modules`);
    }
  });

  it('places a finder pattern at three corners and not the fourth', () => {
    for (const version of [1, 3, 7, 10]) {
      const { size, modules } = encodeQr('x'.repeat(byteCapacity(version)));
      const centres = [[3, 3], [3, size - 4], [size - 4, 3]];

      for (const [cr, cc] of centres) {
        for (let dr = -3; dr <= 3; dr += 1) {
          for (let dc = -3; dc <= 3; dc += 1) {
            // The standard ring: dark at 0, 1 and 3, light at 2. That is the 7x7
            // pattern a scanner locks onto, so it is worth asserting module by
            // module rather than trusting the corner looks about right.
            const expected = ring(dr, dc) !== 2;
            assert.equal(
              modules[cr + dr][cc + dc], expected,
              `v${version} finder at (${cr},${cc}) wrong at offset (${dr},${dc})`,
            );
          }
        }
      }

      // Separators: the full ring at Chebyshev distance 4 is light, which is what
      // keeps the finder from merging into the data around it.
      for (const [cr, cc] of centres) {
        for (let dr = -4; dr <= 4; dr += 1) {
          for (let dc = -4; dc <= 4; dc += 1) {
            if (ring(dr, dc) !== 4) continue;
            const r = cr + dr;
            const c = cc + dc;
            if (r < 0 || c < 0 || r >= size || c >= size) continue;
            assert.equal(modules[r][c], false,
              `v${version} separator at (${r},${c}) should be light`);
          }
        }
      }

      // The fourth corner must NOT be a finder — a symbol with four of them has
      // no orientation. Version 1 has plain data there; version 2 and up have an
      // alignment pattern, whose ring 1 is light where a finder's is dark.
      assert.equal(modules[size - 4][size - 4] && modules[size - 5][size - 5]
        && modules[size - 3][size - 3] && modules[size - 6][size - 6],
      false, `v${version} bottom-right corner looks like a finder`);
    }
  });

  it('alternates the timing patterns along row and column 6', () => {
    for (let v = MIN_VERSION; v <= MAX_VERSION; v += 1) {
      const { size, modules } = encodeQr('x'.repeat(byteCapacity(v)));
      // Columns 0-7 and size-8..size-1 belong to the finders and separators; the
      // timing run proper is what lies between them, and it is dark on even
      // coordinates. From version 7 an alignment pattern crosses row 6, and this
      // still holds — the alignment centres are even, so its dark/light/dark
      // spine lands exactly in step with the timing run.
      for (let i = 8; i <= size - 9; i += 1) {
        assert.equal(modules[6][i], i % 2 === 0, `v${v} row 6 breaks at col ${i}`);
        assert.equal(modules[i][6], i % 2 === 0, `v${v} col 6 breaks at row ${i}`);
      }
    }
  });

  it('places alignment patterns on the centres the specification tabulates', () => {
    // This is the one structural table a round trip cannot check. Both directions
    // derive the reserved map from the same alignmentCentres(), so a wrong centre
    // is a mistake they would make together and still agree on — the symbol would
    // decode here and fail on a real scanner. Hence the literal ISO table.
    const SPEC_CENTRES = {
      1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
      7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    };

    for (let v = MIN_VERSION; v <= MAX_VERSION; v += 1) {
      const { modules } = encodeQr('x'.repeat(byteCapacity(v)));
      const centres = SPEC_CENTRES[v];
      const last = centres.length - 1;
      let placed = 0;

      for (let i = 0; i <= last; i += 1) {
        for (let j = 0; j <= last; j += 1) {
          // The three pairings that would land on a finder are skipped.
          if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
          placed += 1;
          const [r, c] = [centres[i], centres[j]];
          for (let dr = -2; dr <= 2; dr += 1) {
            for (let dc = -2; dc <= 2; dc += 1) {
              // 5x5: dark centre, light ring, dark border.
              assert.equal(
                modules[r + dr][c + dc], ring(dr, dc) !== 1,
                `v${v} alignment at (${r},${c}) wrong at offset (${dr},${dc})`,
              );
            }
          }
        }
      }

      // Version 1 has none; 2-6 have one at the bottom right; 7-10 have six.
      assert.equal(placed, v === 1 ? 0 : (v < 7 ? 1 : 6), `v${v} placed ${placed} alignments`);
    }
  });

  it('sets the dark module and mirrors the version block', () => {
    for (let v = MIN_VERSION; v <= MAX_VERSION; v += 1) {
      const { size, modules } = encodeQr('x'.repeat(byteCapacity(v)));
      // Always dark, just above the lower-left format field. A scanner uses it to
      // confirm it has found a QR symbol and not a lookalike.
      assert.equal(modules[size - 8][8], true, `v${v} dark module is light`);

      // The version information appears from version 7 as two copies, one the
      // transpose of the other. Asserting the symmetry checks the placement
      // without restating the BCH code the encoder already computes.
      if (v < 7) continue;
      for (let i = 0; i < 18; i += 1) {
        const far = size - 11 + (i % 3);
        const near = Math.floor(i / 3);
        assert.equal(modules[near][far], modules[far][near],
          `v${v} version bit ${i} disagrees between its two copies`);
      }
    }
  });
});

describe('version selection', () => {
  it('picks the smallest version that fits, at every capacity boundary', () => {
    // The boundary is the assertion: a payload of exactly byteCapacity(v) must
    // still fit in v, and one byte more must step up. Off-by-one here would
    // either overflow the bit buffer or waste a whole version.
    for (let v = MIN_VERSION; v < MAX_VERSION; v += 1) {
      const cap = byteCapacity(v);
      assert.equal(encodeQr('x'.repeat(cap)).version, v, `${cap} bytes should fit v${v}`);
      assert.equal(encodeQr('x'.repeat(cap + 1)).version, v + 1,
        `${cap + 1} bytes should need v${v + 1}`);
    }
  });

  it('is monotonic: a longer payload never yields a smaller version', () => {
    let previous = 0;
    for (let len = 0; len <= byteCapacity(MAX_VERSION); len += 7) {
      const { version } = encodeQr('x'.repeat(len));
      assert.ok(version >= previous, `${len} bytes fell from v${previous} to v${version}`);
      previous = version;
    }
  });

  it('accounts for the 16-bit count indicator at version 10', () => {
    // Byte mode's character count widens from 8 to 16 bits at version 10, so
    // version 10 loses a byte to its own header. 213 rather than 214 is that
    // extra byte, and it is why capacity cannot be a simple codeword count.
    assert.equal(byteCapacity(MAX_VERSION), 213);
    assert.equal(byteCapacity(9), 180);
  });
});

describe('format information and mask selection', () => {
  /**
   * The format field is the only place a symbol states its own error-correction
   * level and mask number, and `decodeQr` consumes both without exposing either.
   * Reading the 15 bits here — the first copy's layout, unmasked with 0x5412 —
   * is what lets these two properties be asserted at all.
   */
  const FORMAT_POSITIONS = (() => {
    const positions = [];
    for (let i = 0; i <= 5; i += 1) positions.push([i, 8]);
    positions.push([7, 8], [8, 8], [8, 7]);
    for (let i = 9; i < 15; i += 1) positions.push([8, 14 - i]);
    return positions;
  })();

  function readFormat({ modules }) {
    let raw = 0;
    for (let i = 0; i < 15; i += 1) {
      const [r, c] = FORMAT_POSITIONS[i];
      if (modules[r][c]) raw |= 1 << i;
    }
    const data = (raw ^ 0x5412) >>> 10;
    return { level: data >>> 3, mask: data & 0b111 };
  }

  it('always declares error-correction level M', () => {
    // Level M's two-bit code is 00. If this ever read non-zero, decodeQr's own
    // level check would start rejecting symbols this encoder produced.
    for (const text of ['A', PASS_TOKEN, 'x'.repeat(120), 'x'.repeat(213)]) {
      const symbol = encodeQr(text);
      assert.equal(readFormat(symbol).level, 0, `level for ${text.length} bytes`);
      assert.equal(symbol.ecLevel, 'M');
    }
  });

  it('actually chooses among the eight masks rather than settling on one', () => {
    // Mask choice is a quality heuristic, not a correctness property — every mask
    // decodes, so a round trip cannot tell whether the search ran at all. But an
    // encoder that silently always emitted mask 0 would produce needlessly
    // scanner-hostile symbols, and only the spread of chosen masks reveals it.
    const texts = ['A', 'hi', PASS_TOKEN];
    for (let n = 1; n <= 213; n += 11) texts.push('x'.repeat(n));

    const chosen = new Set(texts.map((t) => readFormat(encodeQr(t)).mask));
    for (const mask of chosen) assert.ok(mask >= 0 && mask <= 7, `mask ${mask} out of range`);
    assert.ok(chosen.size > 1,
      `mask selection degenerated: every payload chose from ${[...chosen]}`);
  });

  it('records the mask the modules were actually masked with', () => {
    // The round trip proves this implicitly, since decodeQr unmasks using the
    // number it reads from here rather than being told. Stating it directly means
    // a format/mask mismatch is reported as such instead of as lost payload.
    const symbol = encodeQr(PASS_TOKEN);
    const { mask } = readFormat(symbol);
    assert.ok(Number.isInteger(mask) && mask >= 0 && mask <= 7);
    assert.equal(decodeQr(symbol), PASS_TOKEN);
  });
});

describe('the 213-byte cap', () => {
  it('encodes exactly 213 bytes', () => {
    const symbol = encodeQr('x'.repeat(213));
    assert.equal(symbol.version, MAX_VERSION);
    assert.equal(symbol.size, 57);
    assert.equal(decodeQr(symbol).length, 213);
  });

  it('refuses 214, naming both the payload and the limit', () => {
    assert.throws(() => encodeQr('x'.repeat(214)), (err) => {
      assert.ok(err instanceof RangeError, `expected RangeError, got ${err.constructor.name}`);
      assert.match(err.message, /214 bytes/);
      assert.match(err.message, /213 bytes/);
      return true;
    });
  });

  it('rejects a non-string outright', () => {
    // A number would have a charCodeAt of undefined and encode as garbage, so the
    // type check is load-bearing rather than decoration.
    assert.throws(() => encodeQr(12345), TypeError);
    assert.throws(() => encodeQr(null), TypeError);
    assert.throws(() => encodeQr(undefined), TypeError);
  });
});

describe('determinism', () => {
  it('encodes the same string to the same modules every time', () => {
    // Mask selection walks all eight masks and keeps the lowest penalty. If two
    // masks ever tied and the tie-break drifted, the pass image would change
    // between renders of the same token.
    const a = encodeQr(PASS_TOKEN);
    const b = encodeQr(PASS_TOKEN);
    assert.deepEqual(a.modules, b.modules);
    assert.equal(a.version, b.version);
    assert.equal(a.size, b.size);
  });

  it('is stable across versions and unaffected by encode order', () => {
    const texts = ['A', PASS_TOKEN, 'x'.repeat(120), 'x'.repeat(213)];
    const first = texts.map((t) => encodeQr(t).modules);
    const second = [...texts].reverse().map((t) => encodeQr(t).modules).reverse();
    assert.deepEqual(first, second);
  });

  it('gives different payloads different symbols', () => {
    // Guards the pathological failure where the payload is dropped and every
    // token renders the same square.
    assert.notDeepEqual(encodeQr('A').modules, encodeQr('B').modules);
  });
});

describe('toSvgPath', () => {
  it('emits one merged subpath per horizontal dark run', () => {
    const { modules, size } = encodeQr(PASS_TOKEN);
    const path = toSvgPath(modules);
    assert.ok(path.length > 0, 'path is empty');
    assert.ok(path.startsWith('M'), `path starts with ${path.slice(0, 4)}`);

    // The command count is the check that matters: merging adjacent modules is
    // the whole point of this function, so the subpath count must equal the run
    // count and not the dark-module count.
    const runs = darkRunCount(modules);
    const subpaths = (path.match(/M/g) ?? []).length;
    assert.equal(subpaths, runs);
    assert.equal((path.match(/z/g) ?? []).length, runs, 'every subpath must close');

    // Plausibility bounds, so the equality above cannot be satisfied by two
    // matching bugs: a real symbol has more runs than rows and fewer than the
    // half of its cells that an alternating checkerboard would give.
    const dark = modules.flat().filter(Boolean).length;
    assert.ok(runs > size, `only ${runs} runs in a ${size}x${size} symbol`);
    assert.ok(runs <= dark, `${runs} runs cannot exceed ${dark} dark modules`);
  });

  it('scales by moduleSize without changing the command count', () => {
    const { modules } = encodeQr('A');
    const unit = toSvgPath(modules);
    const scaled = toSvgPath(modules, 4);
    assert.equal((scaled.match(/M/g) ?? []).length, (unit.match(/M/g) ?? []).length);
    assert.notEqual(scaled, unit);
    // Module units at the default scale, so no rounding artefacts in the markup.
    assert.ok(!unit.includes('.'), 'unit-scale path should hold whole numbers');
    // Every rectangle is one module tall, so the vertical command reflects scale.
    assert.ok(unit.includes('v1'), 'expected v1 at unit scale');
    assert.ok(scaled.includes('v4'), 'expected v4 at scale 4');
  });

  it('validates its arguments', () => {
    const { modules } = encodeQr('A');
    assert.throws(() => toSvgPath(modules, 0), RangeError);
    assert.throws(() => toSvgPath(modules, -2), RangeError);
    assert.throws(() => toSvgPath(modules, Number.NaN), RangeError);
    assert.throws(() => toSvgPath('not a matrix'), TypeError);
  });

  it('returns an empty path for an all-light matrix', () => {
    assert.equal(toSvgPath([[false, false], [false, false]]), '');
  });
});

describe('error correction', () => {
  /**
   * READ THIS BEFORE TRUSTING ANY CLAIM ABOUT DAMAGE RECOVERY.
   *
   * The encoder really does compute Reed-Solomon codewords at level M and
   * interleave them into the symbol — a scanner reading one of these would get
   * that protection. But `decodeQr` does NOT use them. qr.js says so at lines
   * 25-34 and again at 659-667: it reads the data codewords and ignores the EC
   * codewords entirely, on the deliberate grounds that a decoder able to repair
   * damage would also repair the encoder's own bugs and report a broken symbol as
   * fine.
   *
   * So there is no way to assert damage recovery from this side of the module, and
   * the tests below do not pretend to. They pin what actually happens, which is
   * the opposite: damage to a payload module is either detected or read straight
   * through. Level M's ~15% tolerance is a property of the emitted symbol that
   * only a real scanner can confirm; it is NOT exercised by this suite.
   */

  // 14 characters is exactly version 1's capacity, so the symbol contains zero
  // padding codewords and every data-codeword bit is header or payload. That is
  // what makes the flips below unambiguous.
  const FULL_V1 = 'CIQ:PSS_012345';

  it('leaves no padding at exact capacity, so the flips below hit real payload', () => {
    assert.equal(FULL_V1.length, byteCapacity(1));
    const symbol = encodeQr(FULL_V1);
    assert.equal(symbol.version, 1);
    assert.equal(decodeQr(symbol), FULL_V1);
  });

  it('does not repair a damaged payload module — every flip is lost or refused', () => {
    const symbol = encodeQr(FULL_V1);
    // Columns 19 and 20, rows 9 to 20, are the first modules the zig-zag fills,
    // which makes them the mode indicator, the character count and the opening
    // payload bytes. If Reed-Solomon correction were applied on read, a single
    // flip in any of them would come back INTACT. None of them do.
    const outcomes = new Set();
    for (let row = 20; row >= 9; row -= 1) {
      for (const col of [20, 19]) {
        const outcome = readBack(withFlip(symbol, row, col), FULL_V1);
        assert.notEqual(outcome, 'INTACT',
          `flip at (${row},${col}) was silently recovered — did decodeQr gain EC?`);
        outcomes.add(outcome);
      }
    }
    // Both failure shapes occur: the header flips are caught by a sanity check,
    // the payload flips are simply read as different bytes.
    assert.deepEqual([...outcomes].sort(), ['CHANGED', 'THREW']);
  });

  it('reads a corrupted payload byte straight through, uncorrected', () => {
    // Module (14,20) holds the high bit of the first payload byte. Flipping it
    // turns 'C' (0x43) into 0xC3 and the decoder hands that back without
    // complaint: a concrete demonstration that the EC codewords are inert here.
    const damaged = withFlip(encodeQr(FULL_V1), 14, 20);
    const decoded = decodeQr(damaged);
    assert.notEqual(decoded, FULL_V1);
    assert.equal(decoded.length, FULL_V1.length);
    assert.equal(decoded.charCodeAt(0), 0xc3);
    assert.equal(decoded.slice(1), FULL_V1.slice(1));
  });

  it('ignores damage to the EC region rather than correcting it', () => {
    // Columns 0 and 1, rows 9 to 12, are the last modules filled, so they are the
    // tail of the error-correction codewords. Flipping them changes nothing about
    // the decode — not because the damage was repaired, but because those bits
    // are never read. The distinction is the entire point of this describe block.
    const symbol = encodeQr(FULL_V1);
    for (let row = 9; row <= 12; row += 1) {
      for (const col of [1, 0]) {
        assert.equal(readBack(withFlip(symbol, row, col), FULL_V1), 'INTACT',
          `flip at (${row},${col}) should be outside the data codewords`);
      }
    }
  });

  it('detects a corrupted format field through its BCH check', () => {
    // The one place the codec does check itself: the format information carries a
    // BCH(15,5) code, and a single-bit error in it cannot pass. This is error
    // DETECTION on the format bits only — it says nothing about the payload.
    const symbol = encodeQr(PASS_TOKEN);
    for (const [row, col] of [[0, 8], [8, 8], [8, 0], [4, 8]]) {
      assert.throws(() => decodeQr(withFlip(symbol, row, col)),
        /format information failed its BCH check/,
        `flip at (${row},${col}) slipped past the format check`);
    }
  });
});

describe('malformed input to decodeQr', () => {
  it('rejects a missing or empty matrix', () => {
    assert.throws(() => decodeQr(), /non-empty array of rows/);
    assert.throws(() => decodeQr({}), /non-empty array of rows/);
    assert.throws(() => decodeQr({ modules: [] }), /non-empty array of rows/);
    assert.throws(() => decodeQr({ modules: 'nope' }), TypeError);
  });

  it('rejects a size that disagrees with the matrix', () => {
    const { modules } = encodeQr('A'); // 21x21
    assert.throws(() => decodeQr({ size: 25, modules }), /must be a 25x25 matrix/);
    assert.throws(() => decodeQr({ size: 21, modules: modules.slice(0, 20) }),
      /must be a 21x21 matrix/);
  });

  it('rejects a ragged or non-square matrix', () => {
    const { modules } = encodeQr('A');
    const ragged = copyModules(modules);
    ragged[7] = ragged[7].slice(0, 20);
    assert.throws(() => decodeQr({ modules: ragged }), /must be a 21x21 matrix/);
    assert.throws(() => decodeQr({ modules: [[true, false], [true, false]] }), RangeError);
  });

  it('rejects a width that is not a legal version', () => {
    // 20 is not 4v+17 for any integer v, so there is no version to read it as.
    const square = (n) => Array.from({ length: n }, () => new Array(n).fill(false));
    assert.throws(() => decodeQr({ modules: square(20) }),
      /version 0.75 is not consistent with a size of 20/);
    // 61 would be version 11, past the range this module implements.
    assert.throws(() => decodeQr({ modules: square(61) }), RangeError);
  });

  it('rejects a version that contradicts the size', () => {
    const { modules } = encodeQr('A'); // version 1, 21x21
    assert.throws(() => decodeQr({ modules, version: 2 }),
      /version 2 is not consistent with a size of 21/);
    assert.throws(() => decodeQr({ modules, version: 0 }), RangeError);
  });

  it('refuses a well-shaped matrix that is not a QR symbol', () => {
    // Correct geometry, no format information: caught by the BCH check rather
    // than being unmasked into nonsense and returned as a string.
    const blank = Array.from({ length: 21 }, () => new Array(21).fill(false));
    assert.throws(() => decodeQr({ modules: blank }), Error);
  });
});
