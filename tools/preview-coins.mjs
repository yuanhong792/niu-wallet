// Dev helper: render the real coin badges at 120px and 26px so their shapes can be eyeballed.
// Reads public/coin-icons.js so the preview always matches what the wallet draws.
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('playwright');

const data=readFileSync('public/coin-icons.js','utf8');

const html=`<!doctype html><meta charset="utf-8">
<style>
body{background:#f5f4f0;font-family:system-ui,"Segoe UI",sans-serif;padding:24px;margin:0}
.row{display:flex;gap:28px;align-items:flex-end}
.cell{text-align:center;color:#333}
.big .coin-icon{width:120px;height:120px}
.small .coin-icon{width:26px;height:26px}
.coin-icon{display:block}
.cap{margin-top:8px;font-size:12px;color:#666}
</style>
<div class="row big" id="big"></div>
<div class="row small" id="small" style="margin-top:28px"></div>
<script>${data}</script>
<script>
function coinIcon(symbol){
  const ns='http://www.w3.org/2000/svg';
  const d=window.NIU_COIN_ICONS[symbol];
  const svg=document.createElementNS(ns,'svg');
  svg.setAttribute('viewBox','0 0 32 32');svg.setAttribute('class','coin-icon');
  const c=document.createElementNS(ns,'circle');
  c.setAttribute('cx','16');c.setAttribute('cy','16');c.setAttribute('r','16');
  c.setAttribute('fill',d.color);svg.append(c);
  for(const p of d.paths){
    const el=document.createElementNS(ns,'path');
    el.setAttribute('d',p.d);el.setAttribute('fill','#fff');
    if(p.opacity!==undefined)el.setAttribute('fill-opacity',String(p.opacity));
    svg.append(el);
  }
  return svg;
}
for(const sym of Object.keys(window.NIU_COIN_ICONS)){
  for(const id of ['big','small']){
    const cell=document.createElement('div');cell.className='cell';
    cell.append(coinIcon(sym));
    const cap=document.createElement('div');cap.className='cap';cap.textContent=sym;
    cell.append(cap);document.getElementById(id).append(cell);
  }
}
</script>`;

writeFileSync('tools/.coin-preview.html',html);
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH});
const page=await browser.newPage({viewport:{width:820,height:400},deviceScaleFactor:2});
await page.goto('file:///D:/niu-personal-wallet/tools/.coin-preview.html');
await page.screenshot({path:'tools/.coin-preview.png'});
await browser.close();
console.log('wrote tools/.coin-preview.png');
