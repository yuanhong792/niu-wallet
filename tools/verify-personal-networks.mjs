// Read-only live check through the packaged wallet's own code path:
// boot the bundled backend, create a throwaway vault, query all four networks.
// No signing, no broadcast, no funds move. Reports per-network success/failure.
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';

const pkg='D:/NIU-Wallet-v0.4.0-Windows-x64/resources/app-resources';
const probe=net.createServer();
await new Promise(r=>probe.listen(0,'127.0.0.1',r));
const port=probe.address().port;
await new Promise(r=>probe.close(r));
const origin='http://127.0.0.1:'+port;
const dir=mkdtempSync(join(tmpdir(),'niu-net-'));
const child=spawn(process.execPath,['scripts/server.mjs'],{
  cwd:pkg,
  env:{...process.env,NIU_HTTP_PORT:String(port),NIU_DATA_DIR:dir,NIU_PERSONAL_ONLY:'1'},
  stdio:'ignore'
});

const results=[];
try{
  let html=null;
  for(let i=0;i<120;i++){try{html=await (await fetch(origin)).text();break;}catch{await new Promise(r=>setTimeout(r,100));}}
  if(!html)throw Error('backend did not start');
  const token=html.match(/name="niu-token" content="([a-f0-9]{64})"/)[1];
  const post=(action,data)=>fetch(origin+'/api/personal/'+action,{
    method:'POST',
    headers:{Origin:origin,'Content-Type':'application/json','X-Niu-Token':token},
    body:JSON.stringify(data)
  });

  const state=await (await post('create',{password:'Network-Check-12345!'})).json();
  const addressOf={ethereum:state.addresses.evm,sepolia:state.addresses.evm,bitcoin:state.addresses.btc,bitcoinTest:state.addresses.btcTest,dogecoin:state.addresses.doge};

  for(const network of ['ethereum','sepolia','bitcoin','bitcoinTest','dogecoin']){
    const started=Date.now();
    let lastError=null,attempts=0;
    for(let attempt=0;attempt<3;attempt++){
      attempts++;
      try{
        const r=await post('balance',{network});
        const data=await r.json();
        if(r.status!==200)throw Error(data.error||('HTTP '+r.status));
        results.push({network,status:'ok',address:data.address,balances:data.balances,attempts,ms:Date.now()-started});
        lastError=null;
        break;
      }catch(e){
        lastError=e.message;
        if(attempt<2)await new Promise(r=>setTimeout(r,1500));
      }
    }
    if(lastError)results.push({network,status:'failed',address:addressOf[network],error:lastError,attempts,ms:Date.now()-started});
  }

  await fetch(origin+'/api/shutdown',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Niu-Token':token},body:'{}'});
  await new Promise((r,j)=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(()=>j(Error('backend did not exit')),8000).unref();});

  const failed=results.filter(r=>r.status!=='ok');
  console.log(JSON.stringify({status:failed.length?'partial':'passed',checkedAt:new Date().toISOString(),results},null,2));
  if(failed.length)process.exitCode=1;
}catch(e){
  console.error(JSON.stringify({status:'failed',error:e.message,results},null,2));
  process.exitCode=1;
}finally{
  if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
  rmSync(dir,{recursive:true,force:true});
}
