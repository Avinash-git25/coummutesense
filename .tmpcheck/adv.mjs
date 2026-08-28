import { encodeQr, decodeQr, toSvgPath, renderToCanvas, byteCapacity, MAX_VERSION, MIN_VERSION, EC_LEVEL } from '../web/js/qr.js';

let pass=0, fail=0; const bad=[];
const expectThrow=(name,fn,type)=>{ try{ const r=fn();
    fail++; bad.push(`${name}: did NOT throw, returned ${String(JSON.stringify(r)).slice(0,80)}`);
  }catch(e){ if(type && !(e instanceof type)){ fail++; bad.push(`${name}: threw ${e.constructor.name} not ${type.name}: ${e.message}`);} else pass++; } };
const ok=(name,cond,info='')=>{ if(cond) pass++; else { fail++; bad.push(`${name} ${info}`);} };

// -- encodeQr adversarial input --
expectThrow('encodeQr(undefined)', ()=>encodeQr(undefined), TypeError);
expectThrow('encodeQr(null)', ()=>encodeQr(null), TypeError);
expectThrow('encodeQr(123)', ()=>encodeQr(123), TypeError);
expectThrow('encodeQr({})', ()=>encodeQr({}), TypeError);
expectThrow('encodeQr([])', ()=>encodeQr([]), TypeError);
expectThrow('encodeQr() no args', ()=>encodeQr(), TypeError);
expectThrow('encodeQr non-latin1 rupee', ()=>encodeQr('fare ₹42'), RangeError);
expectThrow('encodeQr emoji', ()=>encodeQr('pass 🚌'), RangeError);
expectThrow('encodeQr 214 bytes (cap+1)', ()=>encodeQr('a'.repeat(214)), RangeError);
expectThrow('encodeQr 10000 bytes', ()=>encodeQr('a'.repeat(10000)), RangeError);

// empty string must WORK
ok('encodeQr("") works', (()=>{ const s=encodeQr(''); return s.version===1 && decodeQr(s)===''; })());
ok('encodeQr 213 bytes works', (()=>{ const t='b'.repeat(213); return decodeQr(encodeQr(t))===t; })());
{ let s=''; for(let i=0x80;i<=0xff;i+=1) s+=String.fromCharCode(i);
  ok('Latin-1 0x80..0xFF round-trip', decodeQr(encodeQr(s))===s); }
{ const s=' \t\n\r|~\u0000\u001f'; ok('control chars round-trip', decodeQr(encodeQr(s))===s); }

// -- shape of encodeQr result --
{ const tok='CIQ:PSS_0123456789:kx7z1a:0123456789abcdef';
  const s=encodeQr(tok);
  ok('ecLevel is M', s.ecLevel===EC_LEVEL, `got ${s.ecLevel}`);
  ok('modules is size x size', s.modules.length===s.size && s.modules.every(r=>r.length===s.size));
  ok('modules are booleans', s.modules.every(r=>r.every(m=>typeof m==='boolean')));
  ok('real pass token picks low version', s.version<=4, `got v${s.version} for ${tok.length} chars`); }

// -- decodeQr adversarial input --
expectThrow('decodeQr()', ()=>decodeQr(), TypeError);
expectThrow('decodeQr(null)', ()=>decodeQr(null), TypeError);
expectThrow('decodeQr({})', ()=>decodeQr({}), TypeError);
expectThrow('decodeQr({modules:[]})', ()=>decodeQr({modules:[]}), TypeError);
expectThrow('decodeQr non-square', ()=>decodeQr({modules:[[true,false],[true]]}), TypeError);
expectThrow('decodeQr ragged rows', ()=>decodeQr({modules:Array.from({length:21},(_,i)=>new Array(i===5?20:21).fill(false))}), TypeError);
expectThrow('decodeQr rows not arrays', ()=>decodeQr({modules:[1,2,3]}), TypeError);
expectThrow('decodeQr bad size (22)', ()=>decodeQr({modules:Array.from({length:22},()=>new Array(22).fill(false))}), RangeError);
expectThrow('decodeQr version 11 size', ()=>decodeQr({modules:Array.from({length:61},()=>new Array(61).fill(false))}), RangeError);
expectThrow('decodeQr all-light 21x21 (bad BCH)', ()=>decodeQr({modules:Array.from({length:21},()=>new Array(21).fill(false))}), Error);
expectThrow('decodeQr size mismatch', ()=>decodeQr({size:25, modules:Array.from({length:21},()=>new Array(21).fill(false))}), TypeError);

{ const s=encodeQr('tamper test'); const m=s.modules.map(r=>r.slice()); m[0][8]=!m[0][8];
  expectThrow('flipped format bit detected', ()=>decodeQr({...s, modules:m}), Error); }
{ const s=encodeQr('tamper test 2'); const m=s.modules.map(r=>r.slice()); m[20][20]=!m[20][20];
  let outcome; try{ outcome=decodeQr({...s,modules:m}); }catch(e){ outcome='THREW'; }
  ok('flipped data module is not silently corrected', outcome!=='tamper test 2', `got ${outcome}`); }

// -- toSvgPath: reconstruct the matrix from the path --
{ const s=encodeQr('svg path check 12345');
  const d=toSvgPath(s.modules, 1);
  const re=/M(-?[\d.]+) (-?[\d.]+)h(-?[\d.]+)v(-?[\d.]+)h(-?[\d.]+)z/g;
  const grid=Array.from({length:s.size},()=>new Array(s.size).fill(false));
  let mt, rects=0;
  while((mt=re.exec(d))!==null){ rects++;
    const x=+mt[1], y=+mt[2], w=+mt[3], h=+mt[4];
    for(let c=x;c<x+w;c+=1) for(let r=y;r<y+h;r+=1) grid[r][c]=true; }
  let same=true;
  for(let r=0;r<s.size;r++) for(let c=0;c<s.size;c++) if(grid[r][c]!==s.modules[r][c]) same=false;
  ok('toSvgPath reconstructs the matrix exactly', same, `(${rects} rects)`);
  ok('toSvgPath emitted something', d.length>0);
  const d2=toSvgPath(s.modules, 2.5);
  ok('toSvgPath scales', d2.includes('h2.5')||d2.includes('v2.5'), d2.slice(0,60)); }
expectThrow('toSvgPath moduleSize 0', ()=>toSvgPath([[true]],0), RangeError);
expectThrow('toSvgPath moduleSize -1', ()=>toSvgPath([[true]],-1), RangeError);
expectThrow('toSvgPath moduleSize NaN', ()=>toSvgPath([[true]],NaN), RangeError);
expectThrow('toSvgPath modules not array', ()=>toSvgPath('nope',1), TypeError);
expectThrow('toSvgPath rows not arrays', ()=>toSvgPath([1,2],1), TypeError);

// -- renderToCanvas with a stub canvas --
function stubCanvas(){ const calls=[];
  return { width:0, height:0, _calls:calls,
    getContext(k){ if(k!=='2d') return null;
      return { fillStyle:'', fillRect(x,y,w,h){ calls.push({x,y,w,h,style:this.fillStyle}); } }; } }; }
{ const s=encodeQr('canvas check');
  const cv=stubCanvas(); renderToCanvas(cv, s.modules, {moduleSize:4, margin:4});
  const side=(s.size+8)*4;
  ok('canvas sized correctly', cv.width===side && cv.height===side, `${cv.width}x${cv.height} vs ${side}`);
  const bg=cv._calls[0];
  ok('background painted first, full area', bg && bg.x===0 && bg.y===0 && bg.w===side && bg.h===side);
  const grid=Array.from({length:s.size},()=>new Array(s.size).fill(false));
  for(const c of cv._calls.slice(1)){
    for(let x=c.x;x<c.x+c.w;x+=4) for(let y=c.y;y<c.y+c.h;y+=4) grid[(y/4)-4][(x/4)-4]=true; }
  let same=true;
  for(let r=0;r<s.size;r++) for(let c=0;c<s.size;c++) if(grid[r][c]!==s.modules[r][c]) same=false;
  ok('renderToCanvas paints exactly the dark modules', same);
  ok('run-merging used (fewer rects than dark modules)',
     cv._calls.length-1 < s.modules.flat().filter(Boolean).length); }
expectThrow('renderToCanvas no canvas', ()=>renderToCanvas(null,[[true]]), TypeError);
expectThrow('renderToCanvas plain object', ()=>renderToCanvas({},[[true]]), TypeError);
expectThrow('renderToCanvas empty modules', ()=>renderToCanvas(stubCanvas(),[]), TypeError);
expectThrow('renderToCanvas modules not array', ()=>renderToCanvas(stubCanvas(),'x'), TypeError);
expectThrow('renderToCanvas moduleSize 0', ()=>renderToCanvas(stubCanvas(),[[true]],{moduleSize:0}), RangeError);
expectThrow('renderToCanvas moduleSize NaN', ()=>renderToCanvas(stubCanvas(),[[true]],{moduleSize:NaN}), RangeError);
expectThrow('renderToCanvas margin -1', ()=>renderToCanvas(stubCanvas(),[[true]],{margin:-1}), RangeError);
expectThrow('renderToCanvas margin 1.5', ()=>renderToCanvas(stubCanvas(),[[true]],{margin:1.5}), RangeError);
expectThrow('renderToCanvas no 2d ctx', ()=>renderToCanvas({getContext:()=>null},[[true]]), Error);

// -- version selection is minimal --
for(let v=MIN_VERSION;v<=MAX_VERSION;v+=1){
  const atCap=encodeQr('x'.repeat(byteCapacity(v)));
  ok(`length ${byteCapacity(v)} picks v${v}`, atCap.version===v, `got v${atCap.version}`);
  if(v>MIN_VERSION){ const justOver=encodeQr('x'.repeat(byteCapacity(v-1)+1));
    ok(`length ${byteCapacity(v-1)+1} picks v${v}`, justOver.version===v, `got v${justOver.version}`); } }

// -- determinism --
{ const a=encodeQr('deterministic'), b=encodeQr('deterministic');
  ok('encodeQr is deterministic', JSON.stringify(a)===JSON.stringify(b)); }

console.log(`ADVERSARIAL BATTERY: pass=${pass} fail=${fail}`);
if(bad.length){ console.log('FAILURES:'); for(const b of bad) console.log('  - '+b); }
