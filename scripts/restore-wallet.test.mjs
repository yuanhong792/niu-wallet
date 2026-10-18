import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,symlinkSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Wallet} from 'ethers';
import {exportPortable} from './portable-vault.mjs';
import {crypt} from './vault-crypto.mjs';

test('offline restore into independent installation preserves keys and refuses overwrite',async()=>{
  const root=mkdtempSync(resolve(tmpdir(),'niu-restore-')),source=resolve(import.meta.dirname,'..');
  mkdirSync(resolve(root,'scripts'));
  for(const file of ['restore-wallet.mjs','portable-vault.mjs','network.mjs','vault-crypto.mjs','wallet-vault.ps1'])copyFileSync(resolve(source,'scripts',file),resolve(root,'scripts',file));
  symlinkSync(resolve(source,'node_modules'),resolve(root,'node_modules'),'junction');
  const wallets=[Wallet.createRandom(),Wallet.createRandom()],password='恢复验收-'+Wallet.createRandom().address;
  const network={chainId:26261015,genesisHash:'0xe98bb84266b6171c8bc753e9c7c0f7adad3cc42909124726c737eef80d62f0df'};
  const file=resolve(root,'钱包备份.json');writeFileSync(file,JSON.stringify(await exportPortable(wallets,password,network)));
  const key='7f'.repeat(32);process.env.NIU_WALLET_VAULT_KEY=key;
  const run=pass=>spawnSync(process.execPath,[resolve(root,'scripts/restore-wallet.mjs')],{input:JSON.stringify({path:file,password:pass}),encoding:'utf8',windowsHide:true,timeout:90000,env:{...process.env,NIU_WALLET_VAULT_KEY:key}});
  const wrong=run(password+'wrong');assert.notEqual(wrong.status,0);assert.equal(existsSync(resolve(root,'runtime/persistent/wallet.dpapi')),false);
  const restored=run(password);assert.equal(restored.status,0,restored.stderr);assert.equal(JSON.parse(restored.stdout).address,wallets[0].address);
  const protectedBefore=readFileSync(resolve(root,'runtime/persistent/wallet.dpapi'),'utf8');
  const plain=process.platform==='win32'?
    spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',resolve(root,'scripts/wallet-vault.ps1'),'-Mode','unprotect'],{input:protectedBefore,encoding:'utf8',windowsHide:true,timeout:30000}).stdout.trim():
    crypt('unprotect',Buffer.from(protectedBefore,'base64')).toString('base64');
  const vault=JSON.parse(Buffer.from(plain,'base64').toString());
  assert.deepEqual(vault.keys.map(k=>new Wallet(k).address),wallets.map(w=>w.address));
  const duplicate=run(password);assert.notEqual(duplicate.status,0);assert.equal(readFileSync(resolve(root,'runtime/persistent/wallet.dpapi'),'utf8'),protectedBefore);
  assert.equal((restored.stdout+restored.stderr+wrong.stderr+duplicate.stderr).includes(password),false);
});
