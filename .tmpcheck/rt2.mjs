import { encodeQr, decodeQr, byteCapacity, MAX_VERSION } from '../web/js/qr.js';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:_-.';
const mk = (n) => { let s=''; for (let i=0;i<n;i++) s += CHARS[(i*7+3)%CHARS.length]; return s; };

let pass=0, fail=0;
const failures=[];
const maxLen = byteCapacity(MAX_VERSION);
for (let n = 0; n <= maxLen; n += 1) {
  const text = mk(n);
  try {
    const sym = encodeQr(text);
    const back = decodeQr(sym);
    if (back === text) pass++;
    else { fail++; failures.push({n, v: sym.version, reason: 'mismatch', got: back.slice(0,24), want: text.slice(0,24), gotLen: back.length}); }
  } catch (e) {
    fail++; failures.push({n, reason: e.constructor.name + ': ' + e.message});
  }
}
console.log(`LENGTH SWEEP 0..${maxLen}: pass=${pass} fail=${fail} total=${maxLen+1}`);
if (failures.length) {
  console.log('first 15 failures:');
  for (const f of failures.slice(0,15)) console.log(JSON.stringify(f));
  const byReason = {};
  for (const f of failures) { const k = f.reason.split(';')[0]; byReason[k]=(byReason[k]||0)+1; }
  console.log('failure buckets:', JSON.stringify(byReason, null, 1));
  console.log('failing lengths:', failures.map(f=>f.n).join(','));
}
