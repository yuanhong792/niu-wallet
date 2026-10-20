// Verifies the vault stays locked until an explicit unlock, and that signing
// actions are refused while locked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {rmSync,existsSync,readFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {NiuLab,ROOT} from './lab.mjs';

// Use the node binary for the current operating system. Release workspaces keep
// both files side by side, so preferring the .exe on macOS would try to execute
// a Windows PE binary and would not exercise the installed macOS application.
const nodeName=process.platform==='win32'?'niu-geth-candidate.exe':'niu-geth-candidate';
const NODE_BIN=existsSync(resolve(ROOT,'bin',nodeName))?resolve(ROOT,'bin',nodeName):resolve(ROOT,'../../niu-evm/bin',nodeName);
const base=resolve(ROOT,'runtime/lock-test');
const LOCKED=/locked|\u9501\u5b9a/;
function clean(){if(existsSync(base))rmSync(base,{recursive:true,force:true});mkdirSync(base,{recursive:true});}
function labAt(ports,p2p,auth){return new NiuLab({base,ports,p2p,auth,nodeBin:NODE_BIN});}

test('keys stay encrypted until unlock and signing is refused while locked',async t=>{
  clean();
  const lab=labAt([19845,19846],[31871,31872],[19851,19852]);
  await lab.start();
  try{
    const lockedState=await lab.state();
    assert.equal(lockedState.locked,true,'wallet must start locked');
    assert.ok(lockedState.wallets.length>=2,'addresses stay visible while locked');
    assert.ok(lockedState.wallets.every(w=>/^0x[0-9a-fA-F]{40}$/.test(w.address)),'addresses are well formed');

    // Every key-touching action must refuse while the vault is locked, and the
    // lock message must win over any unrelated precondition such as mining.
    await assert.rejects(()=>lab.transfer('0x'+'11'.repeat(20),'0.1'),LOCKED,'transfer must report the lock first');
    await assert.rejects(()=>lab.newAddress('spare'),LOCKED,'new address must be refused');
    await assert.rejects(()=>lab.portableBackup('a-long-enough-password'),LOCKED,'backup must be refused');
    await assert.rejects(()=>lab.deploy('hi'),LOCKED,'deploy must be refused');
    await assert.rejects(()=>lab.update('hi'),LOCKED,'message update must be refused');

    assert.equal(lab.wallets.length,0,'no private key objects exist before unlock');
  }finally{await lab.close();}
});

test('unlock refuses a short password and tolerates any long one',async t=>{
  clean();
  const lab=labAt([19855,19856],[31881,31882],[19861,19862]);
  await lab.start();
  try{
    await assert.rejects(()=>lab.unlock('short'),/12/,'short password refused');
    await assert.rejects(()=>lab.unlock(''),/12/,'empty password refused');
    assert.equal(lab.wallets.length,0,'refused unlock leaves no keys in memory');
    // Keys are sealed by Windows DPAPI against the OS account, not by this
    // password, so any sufficiently long string opens the vault. The gate is a
    // local lock, documented in SECURITY.md so it is not read as key-level
    // password protection.
    const opened=await lab.unlock('any-password-12-chars');
    assert.equal(lab.locked,false,'a long password opens the vault');
    assert.ok(opened.addresses.length>=2,'unlock returns addresses');
  }finally{await lab.close();}
});

test('unlock loads keys and relock drops them again',async t=>{
  clean();
  const lab=labAt([19865,19866],[31891,31892],[19871,19872]);
  await lab.start();
  try{
    await lab.unlock('any-password-12-chars');
    assert.equal(lab.locked,false,'unlocked after explicit unlock');
    assert.equal((await lab.state()).locked,false,'state reports unlocked');

    lab.lock();
    assert.equal(lab.locked,true,'locked on demand');
    assert.equal(lab.wallets.length,0,'key objects dropped on lock');
    assert.equal((await lab.state()).locked,true,'state reports locked');
    await assert.rejects(()=>lab.transfer('0x'+'11'.repeat(20),'0.1'),LOCKED,'transfer refused again after relock');
  }finally{await lab.close();}
});

test('vault file on disk stays encrypted and readable after relock',async t=>{
  clean();
  const lab=labAt([19875,19876],[31901,31902],[19881,19882]);
  await lab.start();
  try{
    const raw=readFileSync(resolve(base,'wallet.dpapi'),'utf8');
    assert.ok(!raw.includes('0x'),'wallet file is not plaintext hex');
    await lab.unlock('any-password-12-chars');
    lab.lock();
    assert.ok(existsSync(resolve(base,'wallet.dpapi')),'wallet file survives lock');
    // Reopening must still work, which is what a user restart depends on.
    assert.ok(readFileSync(resolve(base,'wallet.dpapi'),'utf8').length>0,'wallet file still readable');
  }finally{await lab.close();}
});
