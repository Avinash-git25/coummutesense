// Fully INDEPENDENT verifier. Shares nothing with qr.js except encodeQr's output.
// Own GF tables, own ISO tables, own de-interleave, own RS syndrome check.
import { encodeQr } from '../web/js/qr.js';

// --- own GF(256) ---
const E = new Uint8Array(512), L = new Uint8Array(256);
{ let x=1; for (let i=0;i<255;i++){E[i]=x;L[x]=i;x<<=1;if(x&0x100)x^=0x11d;} for(let i=255;i<512;i++)E[i]=E[i-255]; }
const mul=(a,b)=> (a===0||b===0)?0:E[L[a]+L[b]];

// --- own ISO tables (level M) ---
const ALIGN={1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50]};
// [ecPerBlock, [ [nBlocks, dataLen], ... ] ]
const M={1:[10,[[1,16]]],2:[16,[[1,28]]],3:[26,[[1,44]]],4:[18,[[2,32]]],5:[24,[[2,43]]],
         6:[16,[[4,27]]],7:[18,[[4,31]]],8:[22,[[2,38],[2,39]]],9:[22,[[3,36],[2,37]]],10:[26,[[4,43],[1,44]]]};
// ISO Table C.1, level M, masks 0..7, MSB-first
const FMT_M=['101010000010010','101000100100101','101111001111100','101101101001011',
             '100010111111001','100000011001110','100111110010111','100101010100000'];
const MASKS=[(r,c)=>(r+c)%2===0,(r,c)=>r%2===0,(r,c)=>c%3===0,(r,c)=>(r+c)%3===0,
  (r,c)=>(((r/2)|0)+((c/3)|0))%2===0,(r,c)=>((r*c)%2)+((r*c)%3)===0,
  (r,c)=>(((r*c)%2)+((r*c)%3))%2===0,(r,c)=>(((r+c)%2)+((r*c)%3))%2===0];

// --- own function-pattern map, built from the ISO description ---
function funcMap(v){
  const n=4*v+17;
  const f=Array.from({length:n},()=>new Array(n).fill(false));
  const mark=(r,c)=>{ if(r>=0&&c>=0&&r<n&&c<n) f[r][c]=true; };
  // finders + separators (8x8 corners)
  for(const [r0,c0] of [[0,0],[0,n-8],[n-8,0]])
    for(let r=0;r<8;r++) for(let c=0;c<8;c++) mark(r0+r,c0+c);
  // timing
  for(let i=0;i<n;i++){ mark(6,i); mark(i,6); }
  // alignment
  const A=ALIGN[v];
  for(const ar of A) for(const ac of A){
    if((ar===6&&ac===6)||(ar===6&&ac===A[A.length-1])||(ar===A[A.length-1]&&ac===6)) continue;
    for(let dr=-2;dr<=2;dr++) for(let dc=-2;dc<=2;dc++) mark(ar+dr,ac+dc);
  }
  // format (both copies) + dark module
  for(let i=0;i<9;i++){ mark(8,i); mark(i,8); }
  for(let i=0;i<8;i++){ mark(8,n-1-i); mark(n-1-i,8); }
  // version info
  if(v>=7){ for(let i=0;i<6;i++) for(let j=0;j<3;j++){ mark(i,n-11+j); mark(n-11+j,i); } }
  return {n,f};
}

// --- own zig-zag ---
function* zig(n){
  for(let right=n-1;right>=1;right-=2){
    if(right===6) right=5;
    const up=((right+1)&2)===0;
    for(let v=0;v<n;v++){ const r=up?n-1-v:v; yield [r,right]; yield [r,right-1]; }
  }
}

let pass=0,fail=0; const bad=[];
const CH='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:_-.';
const mk=n=>{let s='';for(let i=0;i<n;i++)s+=CH[(i*13+5)%CH.length];return s;};

for(let len=0;len<=213;len++){
  const text=mk(len);
  let sym;
  try { sym=encodeQr(text); } catch(e){ fail++; bad.push(`len ${len}: encode threw ${e.message}`); continue; }
  const {size:n,modules:mm,version:v}=sym;
  const errs=[];

  // 1. size / version consistency
  if(n!==4*v+17) errs.push(`size ${n} != 4*${v}+17`);

  // 2. read format copy 1 (bits 0..14) using ISO layout, compare to table
  const p1=[]; for(let i=0;i<=5;i++)p1.push([i,8]); p1.push([7,8],[8,8],[8,7]);
  for(let i=9;i<15;i++)p1.push([8,14-i]);
  let s1=''; for(let i=14;i>=0;i--){ const[r,c]=p1[i]; s1+= mm[r][c]?'1':'0'; }
  const mask=FMT_M.indexOf(s1);
  if(mask<0) errs.push(`format copy1 ${s1} not in ISO level-M table`);

  // 3. format copy 2 must equal copy 1
  const p2=[]; for(let i=0;i<8;i++)p2.push([8,n-1-i]); for(let i=8;i<15;i++)p2.push([n-15+i,8]);
  let s2=''; for(let i=14;i>=0;i--){ const[r,c]=p2[i]; s2+= mm[r][c]?'1':'0'; }
  if(s2!==s1) errs.push(`format copies differ: ${s1} vs ${s2}`);

  // 4. dark module
  if(mm[n-8][8]!==true) errs.push('dark module at (4v+9,8) is not dark');

  // 5. finder patterns exact
  const FIND=[[1,1,1,1,1,1,1],[1,0,0,0,0,0,1],[1,0,1,1,1,0,1],[1,0,1,1,1,0,1],[1,0,1,1,1,0,1],[1,0,0,0,0,0,1],[1,1,1,1,1,1,1]];
  for(const [r0,c0] of [[0,0],[0,n-7],[n-7,0]])
    for(let r=0;r<7;r++) for(let c=0;c<7;c++)
      if(mm[r0+r][c0+c]!==(FIND[r][c]===1)) { errs.push(`finder@${r0},${c0} wrong at ${r},${c}`); r=c=99; }

  // 6. separators must be light
  for(let i=0;i<8;i++){
    if(mm[7][i]||mm[i][7]) errs.push('TL separator not light');
    if(mm[7][n-1-i]||mm[i][n-8]) errs.push('TR separator not light');
    if(mm[n-8][i]||mm[n-1-i][7]) errs.push('BL separator not light');
  }

  // 7. timing patterns
  for(let i=8;i<n-8;i++){
    if(mm[6][i]!==(i%2===0)) errs.push(`h timing wrong at col ${i}`);
    if(mm[i][6]!==(i%2===0)) errs.push(`v timing wrong at row ${i}`);
  }

  // 8. alignment patterns
  const A=ALIGN[v], lastA=A[A.length-1];
  for(const ar of A) for(const ac of A){
    if((ar===6&&ac===6)||(ar===6&&ac===lastA)||(ar===lastA&&ac===6)) continue;
    for(let dr=-2;dr<=2;dr++) for(let dc=-2;dc<=2;dc++){
      const want = Math.max(Math.abs(dr),Math.abs(dc))!==1;
      if(mm[ar+dr][ac+dc]!==want) errs.push(`alignment@${ar},${ac} wrong`);
    }
  }

  // 9. read codewords via own zig-zag + own unmask
  const {f}=funcMap(v);
  const [ecPer,groups]=M[v];
  const lens=[]; for(const [cnt,dl] of groups) for(let i=0;i<cnt;i++) lens.push(dl);
  const nBlocks=lens.length;
  const totalCw=lens.reduce((a,b)=>a+b,0)+nBlocks*ecPer;
  const stream=new Uint8Array(totalCw);
  let bi=0; const wantBits=totalCw*8;
  for(const [r,c] of zig(n)){
    if(f[r][c]) continue;
    if(bi>=wantBits) break;
    const val = mm[r][c] !== MASKS[mask<0?0:mask](r,c);
    if(val) stream[bi>>>3] |= 0x80>>>(bi&7);
    bi++;
  }
  if(bi<wantBits) errs.push(`only ${bi} data modules, need ${wantBits}`);

  // 10. de-interleave into blocks (data then EC), then RS SYNDROME CHECK
  const dataB=lens.map(l=>new Uint8Array(l));
  const ecB=lens.map(()=>new Uint8Array(ecPer));
  let q=0, longest=Math.max(...lens);
  for(let i=0;i<longest;i++) for(let b=0;b<nBlocks;b++) if(i<lens[b]) dataB[b][i]=stream[q++];
  for(let i=0;i<ecPer;i++) for(let b=0;b<nBlocks;b++) ecB[b][i]=stream[q++];
  for(let b=0;b<nBlocks;b++){
    const cw=[...dataB[b],...ecB[b]];
    for(let s=0;s<ecPer;s++){
      let acc=0;
      for(const byte of cw) acc = mul(acc, E[s]) ^ byte;   // Horner at a^s
      if(acc!==0){ errs.push(`block ${b} RS syndrome S${s} = ${acc} (must be 0)`); break; }
    }
  }

  // 11. decode header + payload from concatenated data blocks
  const flat=new Uint8Array(lens.reduce((a,b)=>a+b,0));
  { let at=0; for(const d of dataB){ flat.set(d,at); at+=d.length; } }
  let cur=0;
  const rd=w=>{let x=0;for(let i=0;i<w;i++){x=(x<<1)|((flat[cur>>>3]>>>(7-(cur&7)))&1);cur++;}return x;};
  const mode=rd(4);
  if(mode!==0b0100) errs.push(`mode ${mode} != byte(4)`);
  const cnt=rd(v>=10?16:8);
  if(cnt!==len) errs.push(`count ${cnt} != ${len}`);
  let got=''; for(let i=0;i<cnt;i++) got+=String.fromCharCode(rd(8));
  if(got!==text) errs.push(`payload mismatch (got ${got.length} chars)`);

  // 12. padding must be the ISO 0xEC/0x11 alternation
  if(cur%8!==0) cur+=8-(cur%8);   // terminator + byte align
  let padIdx=0, padOk=true;
  for(let byteAt=cur/8; byteAt<flat.length; byteAt++){
    const want=(padIdx++%2===0)?0xec:0x11;
    if(flat[byteAt]!==want){ padOk=false; break; }
  }
  if(!padOk) errs.push('pad codewords are not the 0xEC/0x11 alternation');

  if(errs.length===0) pass++; else { fail++; bad.push(`len ${len} (v${v}): ${errs.slice(0,3).join(' | ')}`); }
}
console.log(`INDEPENDENT VERIFY (12 structural+RS checks x 214 lengths): pass=${pass} fail=${fail}`);
if(bad.length){ console.log('FAILURES (first 20):'); for(const b of bad.slice(0,20)) console.log('  '+b);
  console.log('total failing lengths:', bad.length); }
