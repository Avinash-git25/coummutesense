/**
 * CommuteIQ — Feature 3: universal QR pass issuance and validation.
 *
 * ── Design notes ───────────────────────────────────────────────────────────
 * The PRD asks for a "Generate Pass" trigger that shows "a single unified QR
 * code" for a multi-leg journey. A QR code that just contains a journey id would
 * be trivially forgeable — anyone could hand-write one — so the encoded token is
 * HMAC-signed and the validator recomputes the signature.
 *
 * Two decisions worth stating:
 *
 * 1. FARE AUTHORITY IS SERVER-SIDE. `issuePass` does NOT accept a fare or an
 *    itinerary from the client; it re-plans the journey itself and prices it from
 *    domain.legFare. A client that could post its own total would be a client
 *    that could travel for one rupee.
 *
 * 2. PASSES ARE SINGLE USE. The first `verifyPass` marks the pass redeemed; a
 *    second scan is refused. This is a real fare-evasion control, and it also
 *    demonstrates well — scanning the same code twice in front of judges shows
 *    the rejection path rather than just the happy path.
 *
 * The token is kept deliberately short (~44 chars) so the QR stays at a low
 * version and remains easy for a phone camera to read across a room.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { badRequest } from '../http-error.js';
import { planJourney } from './journey.js';

/** Token prefix, so a scanner can reject foreign QR codes immediately. */
const TOKEN_PREFIX = 'CIQ';
/** Truncated HMAC length in hex chars. 16 hex = 64 bits, ample for a transit pass. */
const SIG_LEN = 16;
/** How long an issued pass stays valid. */
export const PASS_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Signing key.
 *
 * Falls back to a fixed development constant so the prototype works offline with
 * no configuration, and so a pass issued before a server restart still validates
 * mid-demo. A real deployment must set COMMUTEIQ_PASS_SECRET — stated plainly
 * here rather than left as an implicit assumption.
 */
const SECRET = process.env.COMMUTEIQ_PASS_SECRET ?? 'commuteiq-dev-secret-do-not-ship';

/** @param {string} data @returns {string} truncated hex HMAC */
function sign(data) {
  return createHmac('sha256', SECRET).update(data).digest('hex').slice(0, SIG_LEN);
}

/** Constant-time signature comparison — a plain `===` leaks timing. */
function signatureMatches(expected, actual) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));
}

/**
 * Build the QR payload.
 * Layout: CIQ:<passId>:<expiryBase36>:<sig>
 */
function buildToken(passId, expiresAtMs) {
  const exp = Math.floor(expiresAtMs / 1000).toString(36);
  const body = `${TOKEN_PREFIX}:${passId}:${exp}`;
  return `${body}:${sign(body)}`;
}

/** @returns {{passId:string, expiresAtMs:number}|null} null when malformed */
function parseToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split(':');
  if (parts.length !== 4) return null;
  const [prefix, passId, expB36, sig] = parts;
  if (prefix !== TOKEN_PREFIX) return null;
  if (!/^PSS_[0-9a-f]{10}$/.test(passId)) return null;

  const expSec = Number.parseInt(expB36, 36);
  if (!Number.isFinite(expSec) || expSec <= 0) return null;
  if (!signatureMatches(sign(`${prefix}:${passId}:${expB36}`), sig)) return null;

  return { passId, expiresAtMs: expSec * 1000 };
}

/**
 * POST /api/v1/pass/issue
 *
 * Body: { fromStopId, toStopId, weather?, preferences?, passengerType? }
 * The itinerary and fare are recomputed server-side from these inputs.
 */
export async function issuePass(ctx) {
  const { store, body } = ctx;
  const { fromStopId, toStopId, passengerType = 'adult' } = body ?? {};

  if (typeof fromStopId !== 'string' || fromStopId === '') {
    throw badRequest('fromStopId is required');
  }
  if (typeof toStopId !== 'string' || toStopId === '') {
    throw badRequest('toStopId is required');
  }

  // Re-plan server-side. The client never supplies legs or fares — and the
  // planner validates passengerType and applies the concession itself, from the
  // one table in domain.js, so the ticket cannot be priced differently from the
  // itinerary the commuter was just shown.
  const plan = await planJourney(ctx);
  if (!plan?.success || !Array.isArray(plan.legs) || plan.legs.length === 0) {
    throw badRequest('could not plan a journey for the requested stops');
  }

  const { fareMultiplier, payableFare } = plan.summary;

  const passId = `PSS_${randomBytes(5).toString('hex')}`;
  const issuedAtMs = Date.now();
  const expiresAtMs = issuedAtMs + PASS_TTL_MS;
  const token = buildToken(passId, expiresAtMs);

  const pass = {
    _id: passId,
    passId,
    token,
    journeyId: plan.journeyId,
    from: plan.from,
    to: plan.to,
    legs: plan.legs,
    summary: plan.summary,
    passengerType,
    fareMultiplier,
    payableFare,
    currency: 'INR',
    status: 'issued',
    issuedAt: new Date(issuedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    redeemedAt: null,
    scanCount: 0,
  };

  store.passes.put(pass);
  return { success: true, pass };
}

/**
 * POST /api/v1/pass/verify
 *
 * Body: { token }
 *
 * A scanner wants a VERDICT, not an exception, so a well-formed token that is
 * simply not acceptable (expired, already redeemed) returns HTTP 200 with
 * `valid:false` and a reason. Only a malformed or unparseable token is a 400,
 * because that means the caller sent something that was never a CommuteIQ pass.
 */
export async function verifyPass(ctx) {
  const { store, body } = ctx;
  const { token } = body ?? {};

  if (typeof token !== 'string' || token === '') {
    throw badRequest('token is required');
  }

  const parsed = parseToken(token);
  if (!parsed) {
    // Covers a bad prefix, a mangled id, and a forged or tampered signature.
    // Deliberately one message for all of them: telling an attacker which part
    // of their forgery failed is free help.
    throw badRequest('token is not a valid CommuteIQ pass');
  }

  const pass = store.passes.get(parsed.passId);
  if (!pass) {
    // Correctly signed but unknown — the usual cause is a server restart having
    // cleared the in-memory store.
    return {
      success: true,
      valid: false,
      reason: 'UNKNOWN_PASS',
      message: 'Pass is not on record. It may have been issued before a restart.',
      passId: parsed.passId,
    };
  }

  const now = Date.now();
  const scanCount = (pass.scanCount ?? 0) + 1;

  if (now > parsed.expiresAtMs) {
    store.passes.update(pass.passId, { status: 'expired', scanCount });
    return {
      success: true,
      valid: false,
      reason: 'EXPIRED',
      message: `Pass expired at ${pass.expiresAt}.`,
      pass: { ...pass, status: 'expired', scanCount },
    };
  }

  if (pass.status === 'redeemed') {
    store.passes.update(pass.passId, { scanCount });
    return {
      success: true,
      valid: false,
      reason: 'ALREADY_REDEEMED',
      message: `Pass was already used at ${pass.redeemedAt}.`,
      pass: { ...pass, scanCount },
    };
  }

  const redeemedAt = new Date(now).toISOString();
  const updated = store.passes.update(pass.passId, {
    status: 'redeemed',
    redeemedAt,
    scanCount,
  });

  return {
    success: true,
    valid: true,
    reason: 'ACCEPTED',
    message: `Valid pass — ${pass.from?.name ?? '?'} to ${pass.to?.name ?? '?'}, ₹${pass.payableFare}.`,
    pass: updated,
  };
}

/**
 * GET /api/v1/pass — issued passes, newest first. Backs the conductor view.
 * Optional `?status=issued|redeemed|expired`.
 */
export async function listPasses(ctx) {
  const { store, query } = ctx;
  const status = query?.get('status') ?? null;
  const VALID = ['issued', 'redeemed', 'expired'];

  if (status !== null && !VALID.includes(status)) {
    throw badRequest(`unknown status: ${status}`, { validStatuses: VALID });
  }

  const passes = store.passes
    .all()
    .filter((p) => status === null || p.status === status)
    .sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));

  return {
    success: true,
    passes,
    summary: {
      total: store.passes.size,
      issued: store.passes.find((p) => p.status === 'issued').length,
      redeemed: store.passes.find((p) => p.status === 'redeemed').length,
      expired: store.passes.find((p) => p.status === 'expired').length,
      revenue: Math.round(
        store.passes.find((p) => p.status === 'redeemed')
          .reduce((s, p) => s + (p.payableFare ?? 0), 0) * 100,
      ) / 100,
    },
  };
}

// Exported for the test suite, which needs to forge and tamper with tokens.
export const __testing = { buildToken, parseToken, sign, TOKEN_PREFIX };
