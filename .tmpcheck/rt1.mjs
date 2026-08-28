import * as m from '../web/js/qr.js';
console.log('exports:', Object.keys(m).sort().join(', '));
for (let v = m.MIN_VERSION; v <= m.MAX_VERSION; v += 1) {
  console.log('v' + v, 'size', 4*v+17, 'cap', m.byteCapacity(v));
}
