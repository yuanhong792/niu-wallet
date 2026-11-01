// Diagnostic probe: drive the real 转出 flow for each coin and print what the UI says.
// Not part of QA - used to see whether the send path is wired end to end.
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const pkg='D:/NIU-Wallet-v0.4.0-Windows-x64/resources/app-resources';
const password='Probe-12345678!';

const probe=net.createServer();
await new Promise(r=>probe.listen(0,'127.0.0.1',r));
const port=probe.address().port;
await new Promise(r=>probe.close(r));
const origin='http://127.0.0.1:'+port;
const dataDir=mkdtempSync(join(tmpdir(),'niu-probe-'));
const child=spawn(process.execPath,['scripts/server.mjs'],{
  cwd:pkg,env:{...process.env,NIU_HTTP_PORT:String(port),NIU_DATA_DIR:dataDir},stdio:'ignore'
});

let browser;
try{
  for(let i=0;i<900;i++){
    try{const r=await fetch(origin+'/api/state');if(r.status===200)break;}catch{}
    await new Promise(r=>setTimeout(r,200));
  }
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH||undefined});
  const page=await browser.newPage({viewport:{width:1360,height:1200}});
  const errors=[];
  page.on('pageerror',e=>errors.push('pageerror: '+e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push('console: '+m.text());});

  await page.goto(origin,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#page-overview.is-active',{timeout:20000});
  await page.click('[data-page="personal"]');
  await page.waitForSelector('#page-personal.is-active');
  await page.fill('#personalPassword',password);
  await page.fill('#personalPasswordAgain',password);
  await page.click('#personalCreate');
  await page.waitForFunction(()=>{
    const c=[...document.querySelectorAll('.asset-card [data-addr]')];
    return c.length>0&&c.every(x=>x.textContent&&x.textContent!=='解锁后显示');
  },null,{timeout:30000});

  const cases=[
    ['bitcoin','BTC','bc1q4jqw5y3mzmjf88d94gsuaxys5a60wnd5c7hsae','0.0001'],
    ['dogecoin','DOGE','DLsDCNvAq78uPAJz74ikxjpAMGm23ibwYj','1'],
    ['ethereum','ETH','0x244C03bc113395Eb3996929B23944e9998C4f050','0.0001'],
    ['sepolia','ETH','0x244C03bc113395Eb3996929B23944e9998C4f050','0.0001']
  ];
  for(const [network,asset,to,amount] of cases){
    const card=page.locator(`.asset-card[data-network="${network}"][data-asset="${asset}"]`);
    if(!await card.isVisible()){
      await page.click(`.chain-tab[data-chain="${network==='sepolia'?'test':'main'}"]`);
      await page.waitForTimeout(300);
    }
    if(await card.locator('[data-send-form]').isHidden())await card.locator('[data-send-toggle]').click();
    await page.waitForFunction(([n,a])=>!document.querySelector(`.asset-card[data-network="${n}"][data-asset="${a}"] [data-send-form]`).hidden,[network,asset],{timeout:20000});
    const inputs=card.locator('[data-send-form] input');
    await inputs.nth(0).fill(to);
    await inputs.nth(1).fill(amount);
    await card.locator('[data-prepare]').click();
    // wait for the message area to change away from the neutral placeholder
    await page.waitForTimeout(6000);
    const msg=(await page.textContent('#personalMessage').catch(()=>''))||'';
    const boxText=(await card.locator('[data-preview]').textContent().catch(()=>''))||'';
    console.log(`--- ${network}/${asset}`);
    console.log('  message :',msg.trim());
    console.log('  preview :',boxText.trim().slice(0,200));
    await card.locator('[data-cancel]').click().catch(()=>{});
    await page.waitForTimeout(500);
  }
  console.log('--- page errors:',errors.length?errors.join(' | '):'none');
}finally{
  await browser?.close();
  child.kill();
}
