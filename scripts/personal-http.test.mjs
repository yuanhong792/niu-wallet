import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
test('personal HTTP routes require origin/token, survive NIU-independent start and persist encrypted identity',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'niu-http-'));
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,['scripts/server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,NIU_HTTP_PORT:String(port),NIU_DATA_DIR:dir,NIU_PERSONAL_ONLY:'1'},stdio:'ignore'});
  try{let html;for(let i=0;i<80;i++){try{const r=await fetch(origin);html=await r.text();break;}catch{await new Promise(r=>setTimeout(r,100));}}assert.ok(html?.includes('personalAssetsMain'));const token=html.match(/name="niu-token" content="([^"]+)"/)[1];
    const post=(action,data,headers={})=>fetch(origin+'/api/personal/'+action,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Niu-Token':token,...headers},body:JSON.stringify(data)});
    assert.equal((await post('create',{password:'HTTP-Test-Only-12345!'},{Origin:'http://attacker.invalid'})).status,403);
    assert.equal((await post('create',{password:'HTTP-Test-Only-12345!'},{'X-Niu-Token':'bad'})).status,403);
    const created=await post('create',{password:'HTTP-Test-Only-12345!'});assert.equal(created.status,200);const state=await created.json();assert.match(state.addresses.btc,/^bc1/);assert.equal(state.locked,false);
    const qr=await(await post('qr',{address:state.addresses.btc})).json();assert.match(qr.svg,/<svg/);
    assert.equal((await post('qr',{address:'unknown'})).status,400);
    await post('lock',{});const unlocked=await post('unlock',{password:'HTTP-Test-Only-12345!'});assert.deepEqual((await unlocked.json()).addresses,state.addresses);
    await fetch(origin+'/api/shutdown',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Niu-Token':token},body:'{}'});
    await new Promise((r,j)=>{if(child.exitCode!==null)return r();child.once('exit',r);setTimeout(()=>j(Error('backend did not exit')),5000).unref();});
  }finally{if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}rmSync(dir,{recursive:true,force:true});}
});
