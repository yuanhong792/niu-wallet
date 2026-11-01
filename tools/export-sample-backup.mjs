// Produce a fresh vault from the packaged wallet and export its encrypted backup
// so an independent implementation can re-derive the addresses.
// Usage: node tools/export-sample-backup.mjs <outDir>
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';

const outDir=process.argv[2];
if(!outDir)throw Error('usage: node tools/export-sample-backup.mjs <outDir>');
const password='Independent-Check-12345!';
const pkg='D:/NIU-Wallet-v0.4.0-Windows-x64/resources/app-resources';

const probe=net.createServer();
await new Promise(r=>probe.listen(0,'127.0.0.1',r));
const port=probe.address().port;
await new Promise(r=>probe.close(r));
const origin='http://127.0.0.1:'+port;
const dataDir=mkdtempSync(join(tmpdir(),'niu-exp-'));
const child=spawn(process.execPath,['scripts/server.mjs'],{
  cwd:pkg,env:{...process.env,NIU_HTTP_PORT:String(port),NIU_DATA_DIR:dataDir,NIU_PERSONAL_ONLY:'1'},stdio:'ignore'
});
try{
  let html=null;
  for(let i=0;i<120;i++){try{html=await (await fetch(origin)).text();break;}catch{await new Promise(r=>setTimeout(r,100));}}
  if(!html)throw Error('backend did not start');
  const token=html.match(/name="niu-token" content="([a-f0-9]{64})"/)[1];
  const post=(a,d)=>fetch(origin+'/api/personal/'+a,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Niu-Token':token},body:JSON.stringify(d)});
  const state=await (await post('create',{password})).json();
  const backup=await (await post('backup',{password})).json();
  await fetch(origin+'/api/shutdown',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Niu-Token':token},body:'{}'});
  await new Promise((r,j)=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(()=>j(Error('backend did not exit')),8000).unref();});
  mkdirSync(outDir,{recursive:true});
  writeFileSync(join(outDir,'backup.json'),JSON.stringify(backup));
  writeFileSync(join(outDir,'expected.json'),JSON.stringify({password,addresses:state.addresses},null,2));
  console.log(JSON.stringify({status:'ok',outDir,addresses:state.addresses},null,2));
}finally{
  if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
  rmSync(dataDir,{recursive:true,force:true});
}
