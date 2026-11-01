// Headless-browser QA for the packaged v0.4.0 bundle, driving the real UI.
// Runs the full app (NIU node + personal multichain) exactly as the desktop shell does.
// Checks: mainnet/testnet tabs, one card per coin with its own logo, per-card address,
// QR, per-card transfer form, card-level refresh, lock behaviour, legacy pages.
// Requires playwright (global install) + PLAYWRIGHT_CHROMIUM_PATH to an existing chromium.
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const pkg='D:/NIU-Wallet-v0.4.0-Windows-x64/resources/app-resources';
const shotDir='D:/niu-personal-wallet/docs/images';
const password='UI-Check-12345678!';
const checks=[];
const ok=(name,cond,extra)=>{if(!cond)throw Error('check failed: '+name+(extra!==undefined?' -> '+extra:''));checks.push(name);};

const probe=net.createServer();
await new Promise(r=>probe.listen(0,'127.0.0.1',r));
const port=probe.address().port;
await new Promise(r=>probe.close(r));
const origin='http://127.0.0.1:'+port;
const dataDir=mkdtempSync(join(tmpdir(),'niu-ui-'));
const child=spawn(process.execPath,['scripts/server.mjs'],{
  cwd:pkg,env:{...process.env,NIU_HTTP_PORT:String(port),NIU_DATA_DIR:dataDir},stdio:'ignore'
});

let browser,page;
try{
  mkdirSync(shotDir,{recursive:true});
  let ready=false;
  for(let i=0;i<900;i++){
    try{const r=await fetch(origin+'/api/state');if(r.status===200){ready=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,200));
  }
  ok('fullAppBoots',ready);

  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH||undefined});
  page=await browser.newPage({viewport:{width:1360,height:1000}});
  const errors=[];
  page.on('pageerror',e=>errors.push('pageerror: '+e.message));
  // A rejected transfer is a normal 400 business answer, and Chromium logs every 4xx as a
  // "Failed to load resource" console error. Keep real script errors, drop that network noise.
  page.on('console',m=>{
    if(m.type()!=='error')return;
    const text=m.text();
    if(/^Failed to load resource: the server responded with a status of 4\d\d/.test(text))return;
    errors.push('console: '+text);
  });

  await page.goto(origin,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#page-overview.is-active',{timeout:20000});
  ok('legacyOverviewStillRenders',true);

  // The sidebar must show which build is running: an old copy of the wallet has no
  // 「个人多链」entry, and without a version the user cannot tell the two apart.
  const versionText=await page.waitForFunction(()=>{
    const t=document.getElementById('appVersion')?.textContent||'';
    return t.trim()?t:'';
  },null,{timeout:30000}).then(h=>h.jsonValue());
  ok('sidebarShowsBuildVersion',/版本\s*0\.4\.0/.test(versionText),versionText);

  await page.click('[data-page="personal"]');
  await page.waitForSelector('#page-personal.is-active');
  ok('personalPageOpens',true);
  ok('sidebarEntryLabelled',(await page.textContent('[data-page="personal"]')).includes('个人多链'));

  // mainnet / testnet are tabs, not a buried section further down the page
  const tabs=await page.$$eval('.chain-tab',els=>els.map(e=>({chain:e.dataset.chain,text:e.textContent.trim(),active:e.classList.contains('is-active')})));
  ok('twoChainTabs',tabs.length===2&&tabs[0].chain==='main'&&tabs[1].chain==='test',JSON.stringify(tabs));
  ok('mainnetTabLabelled',tabs[0].text.includes('主网'),tabs[0].text);
  ok('testnetTabLabelled',tabs[1].text.includes('测试网'),tabs[1].text);
  ok('mainnetSelectedByDefault',tabs[0].active&&!tabs[1].active);
  ok('testnetGridHiddenByDefault',await page.locator('#personalAssetsTest').isHidden());
  ok('tabCountsShown',(await page.textContent('#countMain'))==='5'&&(await page.textContent('#countTest'))==='3');

  const mainSymbols=await page.$$eval('#personalAssetsMain .asset-card',els=>els.map(e=>e.dataset.asset));
  const testSymbols=await page.$$eval('#personalAssetsTest .asset-card',els=>els.map(e=>e.dataset.asset));
  ok('mainnetHasFiveCoins',mainSymbols.join(',')==='ETH,USDT,USDC,BTC,DOGE',mainSymbols.join(','));
  ok('testnetHasThreeCoins',testSymbols.join(',')==='ETH,USDC,BTC',testSymbols.join(','));
  ok('noSharedNetworkSelector',(await page.locator('#personalNetwork').count())===0);

  // every card carries its own coin logo drawn inline (no external artwork needed)
  const icons=await page.$$eval('.asset-card .coin-icon',els=>els.map(e=>({
    label:e.getAttribute('aria-label'),
    circle:e.querySelector('circle')?.getAttribute('fill'),
    shapes:e.querySelectorAll('path,text,rect').length,
    texts:e.querySelectorAll('text').length,
    pathCount:e.querySelectorAll('path').length,
    glyph:[...e.querySelectorAll('path,text,rect')]
      .map(n=>{const tag=n.tagName.toLowerCase();
        return tag==='path'?n.getAttribute('d'):tag==='text'?n.textContent:n.getAttribute('width')+'x'+n.getAttribute('height');})
      .join('|')
  })));
  ok('everyCardHasLogo',icons.length===8,icons.length);
  ok('logosAreDistinctColours',new Set(icons.map(i=>i.circle)).size===5,JSON.stringify(icons.map(i=>i.circle)));
  ok('logosHaveShapes',icons.every(i=>i.shapes>0),JSON.stringify(icons));
  // a coin's badge must not collapse to a plain letter: all five glyphs differ from each other
  ok('logosUseDistinctGlyphs',new Set(icons.map(i=>i.glyph)).size===5,JSON.stringify(icons.map(i=>i.glyph)));
  // the badges must be real vector outlines, not a letter plus a few bars
  ok('logosUsePathsNotLetters',icons.every(i=>i.texts===0),JSON.stringify(icons.map(i=>i.texts)));
  const btcGlyph=icons.find(i=>i.label==='BTC 图标');
  ok('bitcoinLogoIsRealGlyph',btcGlyph.pathCount===1&&btcGlyph.glyph.length>200,btcGlyph.glyph.length);

  // the packaged stylesheet must resolve against the app's light palette, not a stale dark one
  const palette=await page.evaluate(()=>{
    const tab=getComputedStyle(document.querySelector('.chain-tab.is-active'));
    const card=getComputedStyle(document.querySelector('.asset-card'));
    return {body:getComputedStyle(document.body).backgroundColor,tab:tab.backgroundColor,card:card.backgroundColor};
  });
  ok('lightThemeBody',palette.body==='rgb(245, 245, 242)',palette.body);
  ok('activeTabUsesCardSurface',palette.tab==='rgb(255, 255, 255)',palette.tab);
  ok('cardsUseCardSurface',palette.card==='rgb(255, 255, 255)',palette.card);

  await page.fill('#personalPassword',password);
  await page.fill('#personalPasswordAgain',password);
  await page.click('#personalCreate');
  await page.waitForFunction(()=>{
    const codes=[...document.querySelectorAll('.asset-card [data-addr]')];
    return codes.length>0&&codes.every(c=>c.textContent&&c.textContent!=='解锁后显示');
  },null,{timeout:30000});
  ok('allCardsShowAddress',true);

  const addrBySymbol=await page.$$eval('.asset-card',cards=>cards.map(c=>[c.dataset.network+':'+c.dataset.asset,c.querySelector('[data-addr]').textContent]));
  const addrMap=Object.fromEntries(addrBySymbol);
  ok('evmAddressesShared',addrMap['ethereum:ETH']===addrMap['ethereum:USDT']&&addrMap['ethereum:ETH']===addrMap['sepolia:ETH']);
  ok('evmAddressShape',/^0x[0-9a-fA-F]{40}$/.test(addrMap['ethereum:ETH']),addrMap['ethereum:ETH']);
  ok('btcMainnetShape',/^bc1q[0-9a-z]{38,60}$/.test(addrMap['bitcoin:BTC']),addrMap['bitcoin:BTC']);
  ok('btcTestnetShape',/^tb1q[0-9a-z]{38,60}$/.test(addrMap['bitcoinTest:BTC']),addrMap['bitcoinTest:BTC']);
  ok('dogeAddressShape',/^D[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(addrMap['dogecoin:DOGE']),addrMap['dogecoin:DOGE']);
  ok('dogeDiffersFromBtc',addrMap['dogecoin:DOGE']!==addrMap['bitcoin:BTC']);
  ok('createHiddenAfterCreate',await page.locator('#personalCreate').isHidden());

  // switching tabs swaps the visible grid without touching card state
  await page.click('.chain-tab[data-chain="test"]');
  await page.waitForFunction(()=>!document.getElementById('personalAssetsTest').hidden,null,{timeout:10000});
  ok('testnetTabShowsGrid',await page.locator('#personalAssetsMain').isHidden());
  ok('testnetCardsVisible',await page.locator('#personalAssetsTest .asset-card').first().isVisible());
  await page.screenshot({path:join(shotDir,'v040-personal-testnet.png'),fullPage:true});
  await page.click('.chain-tab[data-chain="main"]');
  await page.waitForFunction(()=>!document.getElementById('personalAssetsMain').hidden,null,{timeout:10000});
  ok('mainnetTabRestoresGrid',await page.locator('#personalAssetsMain .asset-card').first().isVisible());

  // QR lives inside its own card
  const btcCard=page.locator('.asset-card[data-network="bitcoin"]');
  await btcCard.locator('[data-qr-toggle]').click();
  await page.waitForFunction(()=>document.querySelector('.asset-card[data-network="bitcoin"] [data-qr] svg')!==null,null,{timeout:20000});
  ok('qrRendersInsideCard',true);
  ok('qrOnlyInOneCard',(await page.locator('.asset-qr:not([hidden])').count())===1);

  // the transfer form belongs to the card that opened it
  const dogeCard=page.locator('.asset-card[data-network="dogecoin"]');
  await dogeCard.locator('[data-send-toggle]').click();
  await page.waitForFunction(()=>!document.querySelector('.asset-card[data-network="dogecoin"] [data-send-form]').hidden,null,{timeout:20000});
  ok('sendFormOpensInCard',true);
  ok('onlyOneSendFormOpen',(await page.locator('.asset-send:not([hidden])').count())===1);
  ok('dogeFormNotesNoTestnet',(await dogeCard.locator('.asset-note').textContent()).includes('Dogecoin'),await dogeCard.locator('.asset-note').textContent());
  await dogeCard.locator('[data-cancel]').click();
  ok('sendFormCloses',await dogeCard.locator('[data-send-form]').isHidden());

  // card-level balance refresh actually talks to the network
  await btcCard.locator('[data-refresh]').click();
  await page.waitForFunction(()=>{
    const el=document.querySelector('.asset-card[data-network="bitcoin"] [data-balance]');
    return el&&el.textContent!=='未查询';
  },null,{timeout:40000});
  ok('cardRefreshFetchesBalance',true);
  ok('otherCardsStayUnqueried',(await page.locator('.asset-card[data-network="ethereum"][data-asset="ETH"] [data-balance]').textContent())==='未查询');

  // "refresh all" must not stop at the first network that fails; every card has to end up
  // with either a number or an explicit failure, never left silently at 未查询.
  await page.click('#personalRefreshAll');
  await page.waitForFunction(()=>{
    const els=[...document.querySelectorAll('.asset-card [data-balance]')];
    return els.length===8&&els.every(e=>e.textContent!=='未查询');
  },null,{timeout:90000});
  ok('refreshAllLeavesNoCardUnqueried',true);
  const afterAll=await page.$$eval('.asset-card [data-balance]',els=>els.map(e=>e.textContent.trim()));
  ok('refreshAllFillsEveryCard',afterAll.every(t=>t==='查询失败'||/^[\d.]+$/.test(t)),JSON.stringify(afterAll));

  // a transfer preview must explain itself in plain language, never leak a raw RPC error
  for(const [network,asset,to,amount] of [
    ['bitcoin','BTC','bc1q4jqw5y3mzmjf88d94gsuaxys5a60wnd5c7hsae','0.0001'],
    ['dogecoin','DOGE','DLsDCNvAq78uPAJz74ikxjpAMGm23ibwYj','1'],
    ['ethereum','ETH','0x244C03bc113395Eb3996929B23944e9998C4f050','0.0001']
  ]){
    const card=page.locator(`.asset-card[data-network="${network}"][data-asset="${asset}"]`);
    if(await card.locator('[data-send-form]').isHidden())await card.locator('[data-send-toggle]').click();
    await card.locator('[data-send-form] input').nth(0).fill(to);
    await card.locator('[data-send-form] input').nth(1).fill(amount);
    await card.locator('[data-prepare]').click();
    await page.waitForFunction(()=>{
      const t=document.getElementById('personalMessage').textContent;
      return t&&t!=='正在处理…';
    },null,{timeout:60000});
    const msg=await page.textContent('#personalMessage');
    ok('sendPreviewExplainsItself:'+network,/[\u4e00-\u9fa5]/.test(msg),msg);
    ok('sendPreviewNoRawRpcError:'+network,!/missing revert|revert data|CALL_EXCEPTION|undefined|\[object/i.test(msg),msg);
    await card.locator('[data-cancel]').click().catch(()=>{});
  }

  // A truncated address must be rejected in Chinese, not with ethers' bare "invalid address".
  {
    const card=page.locator('.asset-card[data-network="ethereum"][data-asset="ETH"]');
    if(await card.locator('[data-send-form]').isHidden())await card.locator('[data-send-toggle]').click();
    await card.locator('[data-send-form] input').nth(0).fill('0x45Fb675fAa6743207FE83faC6f872E28cad97AF');
    await card.locator('[data-send-form] input').nth(1).fill('0.001');
    await card.locator('[data-prepare]').click();
    await page.waitForFunction(()=>/格式不对|42 个字符/.test(document.getElementById('personalMessage').textContent),null,{timeout:30000});
    ok('badAddressRejectedInChinese',true);
    await card.locator('[data-cancel]').click().catch(()=>{});
  }

  await page.screenshot({path:join(shotDir,'v040-personal-unlocked.png'),fullPage:true});

  await page.fill('#personalPassword',password);
  await page.click('#personalLock');
  await page.waitForFunction(()=>document.getElementById('personalLockState').textContent.includes('已锁定'),null,{timeout:20000});
  ok('lockedBanner',true);
  ok('sendDisabledWhileLocked',await btcCard.locator('[data-send-toggle]').isDisabled());
  ok('lockClosesOpenForm',(await page.locator('.asset-send:not([hidden])').count())===0);

  await page.fill('#personalPassword',password);
  await page.click('#personalUnlock');
  await page.waitForFunction(()=>document.querySelector('.asset-card[data-network="bitcoin"] [data-addr]').textContent.startsWith('bc1'),null,{timeout:30000});
  ok('unlockRestoresSameAddress',(await btcCard.locator('[data-addr]').textContent())===addrMap['bitcoin:BTC']);

  await page.click('[data-page="overview"]');
  await page.waitForSelector('#page-overview.is-active');
  ok('legacyPagesStillUsable',true);
  ok('noBrowserErrors',errors.length===0,errors.join(' | '));

  console.log(JSON.stringify({
    status:'passed',checks,count:checks.length,
    addresses:{evm:addrMap['ethereum:ETH'],bitcoin:addrMap['bitcoin:BTC'],dogecoin:addrMap['dogecoin:DOGE'],bitcoinTest:addrMap['bitcoinTest:BTC']},
    layout:{mainnet:mainSymbols,testnet:testSymbols},
    screenshots:[join(shotDir,'v040-personal-unlocked.png'),join(shotDir,'v040-personal-testnet.png')]
  },null,2));
}catch(e){
  let hint='';
  try{if(page)hint=await page.textContent('#personalMessage');}catch{}
  console.error(JSON.stringify({status:'failed',error:e.message,pageMessage:hint,checks,count:checks.length},null,2));
  process.exitCode=1;
}finally{
  if(browser)await browser.close().catch(()=>{});
  if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
  rmSync(dataDir,{recursive:true,force:true});
}
