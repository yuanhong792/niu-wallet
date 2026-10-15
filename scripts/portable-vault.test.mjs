import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Wallet,verifyMessage} from 'ethers';
import {exportPortable,importPortable} from './portable-vault.mjs';

test('portable backup restores signing identity without Windows credentials',async()=>{
  const wallets=[Wallet.createRandom(),Wallet.createRandom(),Wallet.createRandom()];
  const network={chainId:26261017,genesisHash:'0x'+'ab'.repeat(32)};
  const password='qa-only-'+Wallet.createRandom().address;
  const backup=await exportPortable(wallets,password,network),text=JSON.stringify(backup);
  for(const w of wallets)assert.equal(text.includes(w.privateKey.slice(2)),false);
  const restored=await importPortable(text,password,network);
  assert.deepEqual(restored.map(w=>w.address),wallets.map(w=>w.address));
  assert.equal(verifyMessage('NIU backup restore acceptance',await restored[0].signMessage('NIU backup restore acceptance')),wallets[0].address);
  await assert.rejects(importPortable(text,password+'wrong',network),/密码/);
  await assert.rejects(importPortable(text,password,{...network,chainId:1}),/另一条网络/);
  const bad=structuredClone(backup);bad.accounts[0].Crypto.kdfparams.n=2**30;
  await assert.rejects(importPortable(JSON.stringify(bad),password,network),/参数/);
  const changed=structuredClone(backup);changed.accounts[0].Crypto.ciphertext='00'.repeat(32);
  await assert.rejects(importPortable(JSON.stringify(changed),password,network),/密码/);
  await assert.rejects(exportPortable(wallets,'short',network),/12/);
});
