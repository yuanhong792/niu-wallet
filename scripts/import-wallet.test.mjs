import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Wallet} from 'ethers';
import {NiuLab} from './lab.mjs';
import {exportPortable} from './portable-vault.mjs';
import {crypt} from './vault-crypto.mjs';

test('selected portable backup merges addresses atomically and skips duplicates',async()=>{
  process.env.NIU_WALLET_VAULT_KEY='42'.repeat(32);
  const dir=mkdtempSync(join(tmpdir(),'niu-import-'));
  const current=[Wallet.createRandom(),Wallet.createRandom()];
  const incoming=[Wallet.createRandom(),Wallet.createRandom()];
  const network={chainId:26261017,genesisHash:'0x'+'95'.repeat(32)};
  const password='import-test-'+Wallet.createRandom().address;
  const backup=JSON.stringify(await exportPortable(incoming,password,network));
  const lab=Object.create(NiuLab.prototype);
  Object.assign(lab,{ready:true,busy:false,locked:false,wallets:current,walletAddresses:current.map(w=>w.address),
    walletFile:join(dir,'wallet.dpapi'),metaFile:join(dir,'activity.json'),meta:{transactions:[]},network,genesisHash:network.genesisHash});
  try{
    await assert.rejects(()=>lab.importWalletText(backup,password+'wrong'),/密码/);
    const result=await lab.importWalletText(backup,password);
    assert.equal(result.added,2);
    assert.equal(result.total,4);
    assert.deepEqual(result.addresses,[...current,...incoming].map(w=>w.address));
    const encrypted=Buffer.from(readFileSync(lab.walletFile,'utf8'),'base64');
    const vault=JSON.parse(crypt('unprotect',encrypted).toString());
    assert.deepEqual(vault.keys.map(key=>new Wallet(key).address),result.addresses);
    const duplicate=await lab.importWalletText(backup,password);
    assert.equal(duplicate.added,0);
    assert.equal(duplicate.total,4);
    assert.equal(lab.meta.backupRequired,true);
  }finally{
    rmSync(dir,{recursive:true,force:true});
    delete process.env.NIU_WALLET_VAULT_KEY;
  }
});
