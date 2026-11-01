// Smoke-test the packaged v0.4.0 bundle: boot the backend that ships inside
// resources/app-resources and drive the personal multichain routes over HTTP.
// No real funds, no mainnet broadcast: create / lock / unlock / backup only.
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';

const pkg='D:/NIU-Wallet-v0.4.0-Windows-x64/resources/app-resources';
const checks=[];
const fail=(m)=>{throw Error(m);};
const ok=(name,cond)=>{if(!cond)fail('check failed: '+name);checks.push(name);};

const probe=net.createServer();
await new Promise(r=>probe.listen(0,'127.0.0.1',r));
const port=probe.address().port;
await new Promise(r=>probe.close(r));
const origin='http://127.0.0.1:'+port;
const dir=mkdtempSync(join(tmpdir(),'niu-pkg-'));

const child=spawn(process.execPath,['scripts/server.mjs'],{
  cwd:pkg,
  env:{...process.env,NIU_HTTP_PORT:String(port),NIU_DATA_DIR:dir,NIU_PERSONAL_ONLY:'1'},
  stdio:'ignore'
});

try{
  let html=null;
  for(let i=0;i<120;i++){
    try{html=await (await fetch(origin)).text();break;}catch{await new Promise(r=>setTimeout(r,100));}
  }
  ok('backendBootsFromPackage',Boolean(html));
  ok('personalPagePresent',html.includes('personalAssetsMain')&&html.includes('个人多链'));
  ok('sessionTokenIssued',/name="niu-token" content="[a-f0-9]{64}"/.test(html));
  const token=html.match(/name="niu-token" content="([a-f0-9]{64})"/)[1];

  const css=await (await fetch(origin+'/personal.css')).text();
  ok('personalStylesheetServed',css.includes('var(--accent)'));
  ok('stylesheetFollowsAppTheme',!css.includes('#a9afbc'));
  const js=await (await fetch(origin+'/personal.js')).text();
  ok('personalScriptServed',js.includes('/api/personal/'));
  ok('classicScriptNotModule',!js.trimStart().startsWith('import '));
  // a broadcast stays "等待确认" forever unless the page actually asks the backend for the outcome
  ok('pagePollsTransactionStatus',js.includes("api('refresh')")&&js.includes('scheduleHistoryPoll'));
  // the coin badges live in their own file; if it is not served every card renders blank
  const icons=await (await fetch(origin+'/coin-icons.js')).text();
  ok('coinIconsServed',icons.includes('NIU_COIN_ICONS'));
  ok('coinIconsCoverFiveCoins',['BTC','ETH','USDT','USDC','DOGE'].every(s=>icons.includes(s+':{')));
  ok('coinIconsAreVectorPaths',(icons.match(/\{d:'/g)||[]).length>=5);
  ok('pageLoadsCoinIconsBeforeScript',html.indexOf('/coin-icons.js')>0&&html.indexOf('/coin-icons.js')<html.indexOf('/personal.js'));
  // The bundle is replaced in place, so the page and its scripts must never be cached:
  // a stale copy is what makes an upgraded wallet keep showing the previous UI.
  const pageRes=await fetch(origin+'/');
  ok('pageIsNotCached',pageRes.headers.get('cache-control')==='no-store',pageRes.headers.get('cache-control'));
  const jsRes=await fetch(origin+'/personal.js');
  ok('scriptsAreNotCached',jsRes.headers.get('cache-control')==='no-store',jsRes.headers.get('cache-control'));

  const post=(action,data,headers={})=>fetch(origin+'/api/personal/'+action,{
    method:'POST',
    headers:{Origin:origin,'Content-Type':'application/json','X-Niu-Token':token,...headers},
    body:JSON.stringify(data)
  });

  ok('crossSiteRejected',(await post('create',{password:'Package-Smoke-12345!'},{Origin:'http://attacker.invalid'})).status===403);
  ok('missingTokenRejected',(await post('create',{password:'Package-Smoke-12345!'},{'X-Niu-Token':'0'.repeat(64)})).status===403);
  ok('shortPasswordRejected',(await post('create',{password:'short'})).status>=400);

  const created=await post('create',{password:'Package-Smoke-12345!'});
  ok('vaultCreated',created.status===200);
  const state=await created.json();
  ok('btcAddressIsSegwit',/^bc1q[0-9a-z]{38,60}$/.test(state.addresses.btc));
  ok('evmAddressPresent',/^0x[0-9a-fA-F]{40}$/.test(state.addresses.evm));
  ok('startsUnlocked',state.locked===false);

  const qr=await (await post('qr',{address:state.addresses.btc})).json();
  ok('qrRendered',typeof qr.svg==='string'&&qr.svg.startsWith('<svg'));

  const backup=await (await post('backup',{password:'Package-Smoke-12345!'})).json();
  ok('backupFormatTagged',JSON.stringify(backup).includes('niu-personal-vault'));

  await post('lock',{});
  ok('locksAfterLock',(await (await fetch(origin+'/api/personal/state',{headers:{Origin:origin,'X-Niu-Token':token}})).json()).locked===true);
  ok('wrongPasswordRefused',(await post('unlock',{password:'Package-Smoke-123456'})).status>=400);
  const unlocked=await (await post('unlock',{password:'Package-Smoke-12345!'})).json();
  ok('unlockRestoresAddresses',unlocked.addresses.btc===state.addresses.btc&&unlocked.addresses.evm===state.addresses.evm);

  ok('duplicateCreateRefused',(await post('create',{password:'Package-Smoke-12345!'})).status>=400);

  await fetch(origin+'/api/shutdown',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Niu-Token':token},body:'{}'});
  await new Promise((r,j)=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(()=>j(Error('backend did not exit')),8000).unref();});
  ok('gracefulShutdown',true);

  console.log(JSON.stringify({status:'passed',package:pkg,checks,count:checks.length},null,2));
}catch(e){
  console.error(JSON.stringify({status:'failed',error:e.message,checks,count:checks.length},null,2));
  process.exitCode=1;
}finally{
  if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
  rmSync(dir,{recursive:true,force:true});
}
