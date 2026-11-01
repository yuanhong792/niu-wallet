import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Transaction as EvmTransaction,keccak256,Interface} from 'ethers';
import {Transaction,payments,networks} from 'bitcoinjs-lib';
import {PersonalWallet} from './personal-wallet.mjs';
import {DOGE_CHAIN} from './personal-networks.mjs';
import {open} from './personal-vault.mjs';
const password='Personal-Only-Password-123!';
function fixture(options={}){const dir=mkdtempSync(join(tmpdir(),'niu-personal-'));const w=new PersonalWallet(dir,options);return {w,dir,close(){w.lock();rmSync(dir,{recursive:true,force:true});}};}
test('vault encryption, wrong password, tamper, backup restoration and overwrite refusal',async()=>{const a=fixture(),b=fixture();try{
  await a.w.action('create',{password});const owner=a.w.state().addresses;
  const stored=readFileSync(a.w.vault.file,'utf8');assert.ok(!stored.includes(a.w.vault.secret.evm));
  const backup=await a.w.action('backup',{password});a.w.lock();await assert.rejects(a.w.action('unlock',{password:'Incorrect-Password-123!'}));
  const damaged={...backup,tag:'0'.repeat(32)};await assert.rejects(open(damaged,password));
  await b.w.action('restore',{content:JSON.stringify(backup),password});assert.deepEqual(b.w.state().addresses,owner);
  await assert.rejects(b.w.action('restore',{content:JSON.stringify(backup),password}),/拒绝覆盖/);
}finally{a.close();b.close();}});
function provider({chain='0x1',balance=10n**19n,nonce=0,broadcast,receipt=null}={}){return {destroy(){},send:async(m,a)=>{if(m==='eth_chainId')return chain;if(m==='eth_sendRawTransaction')return broadcast?broadcast(a[0]):keccak256(a[0]);if(m==='eth_getTransactionReceipt')return receipt;if(m==='eth_getTransactionByHash')return null;throw Error(m);},getBalance:async()=>balance,getTransactionCount:async()=>nonce,estimateGas:async()=>21000n,getFeeData:async()=>({maxFeePerGas:2000000000n,maxPriorityFeePerGas:1000000000n})};}
test('ETH signing binds chain, destination, amount, fee; confirmation and replay protected',async()=>{let raw;const f=fixture({providerFactory:()=>provider({broadcast:x=>{raw=x;return keccak256(x);}})});try{
  await f.w.action('create',{password});const to='0x0000000000000000000000000000000000000001';
  const draft=await f.w.action('prepare',{network:'ethereum',asset:'ETH',to,amount:'0.001'});
  await assert.rejects(f.w.action('send',{draftId:draft.draftId,confirmation:'确认测试网发送'}),/确认/);assert.equal(raw,undefined);
  const d=await f.w.action('prepare',{network:'ethereum',asset:'ETH',to,amount:'0.001'});
  await f.w.action('send',{draftId:d.draftId,confirmation:'确认主网发送'});const tx=EvmTransaction.from(raw);
  assert.equal(tx.chainId,1n);assert.equal(tx.to,to);assert.equal(tx.value,1000000000000000n);assert.equal(tx.from,f.w.state().addresses.evm);assert.equal(tx.type,2);
  assert.ok(!('raw'in f.w.state().history[0]));await assert.rejects(f.w.action('send',{draftId:d.draftId,confirmation:'确认主网发送'}),/过期/);
  await assert.rejects(f.w.action('prepare',{network:'ethereum',asset:'ETH',to,amount:'0.001'}),/待确认/);
}finally{f.close();}});
test('wrong chain, invalid amount, token/network mismatch and insufficient gas fail before signing',async()=>{const f=fixture({providerFactory:()=>provider({chain:'0x2'})});try{await f.w.action('create',{password});const p={network:'ethereum',asset:'ETH',to:'0x0000000000000000000000000000000000000001',amount:'1'};
  await assert.rejects(f.w.action('prepare',p),/链 ID/);await assert.rejects(f.w.action('prepare',{...p,amount:'1e3'}),/金额/);await assert.rejects(f.w.action('prepare',{...p,network:'sepolia',asset:'USDT'}),/不支持/);
  f.w.providerFactory=()=>provider({balance:1n});await assert.rejects(f.w.action('prepare',p),/不足/);
}finally{f.close();}});
test('ambiguous broadcast is persisted before network failure and blocked after reopening',async()=>{const f=fixture({providerFactory:()=>provider({broadcast:()=>{throw Error('timeout');}})});try{await f.w.action('create',{password});const d=await f.w.action('prepare',{network:'ethereum',asset:'ETH',to:'0x0000000000000000000000000000000000000001',amount:'0.01'});
  await assert.rejects(f.w.action('send',{draftId:d.draftId,confirmation:'确认主网发送'}),/结果未知/);const reopened=new PersonalWallet(f.dir,{providerFactory:()=>provider()});assert.equal(reopened.history[0].status,'unknown');assert.match(reopened.history[0].hash,/^0x[0-9a-f]{64}$/);
}finally{f.close();}});
test('USDT transfer signs the official contract, exact recipient and six-decimal amount',async()=>{let raw;const f=fixture({providerFactory:()=>{const p=provider({broadcast:x=>{raw=x;return keccak256(x);}});p.call=async()=> '0x'+(10000000n).toString(16).padStart(64,'0');p.resolveName=async a=>a;return p;}});try{
  await f.w.action('create',{password});const to='0x0000000000000000000000000000000000000001';const d=await f.w.action('prepare',{network:'ethereum',asset:'USDT',to,amount:'1.234567'});await f.w.action('send',{draftId:d.draftId,confirmation:'确认主网发送'});
  const tx=EvmTransaction.from(raw),i=new Interface(['function transfer(address,uint256) returns(bool)']),decoded=i.decodeFunctionData('transfer',tx.data);assert.equal(tx.to.toLowerCase(),'0xdac17f958d2ee523a2206206994597c13d831ec7');assert.equal(tx.value,0n);assert.equal(decoded[0],to);assert.equal(decoded[1],1234567n);
}finally{f.close();}});
test('nonce changes invalidate EVM preview without broadcasting',async()=>{let calls=0,sends=0;const f=fixture({providerFactory:()=>provider({nonce:calls++===0?0:1,broadcast:x=>{sends++;return keccak256(x);}})});try{await f.w.action('create',{password});const d=await f.w.action('prepare',{network:'ethereum',asset:'ETH',to:'0x0000000000000000000000000000000000000001',amount:'0.01'});await assert.rejects(f.w.action('send',{draftId:d.draftId,confirmation:'确认主网发送'}),/nonce/);assert.equal(sends,0);}finally{f.close();}});
test('BTC signs actual verified previous output, preserves change and rejects wrong network',async()=>{let parent,ownerScript,raw;const f=fixture({request:async(n,path,options)=>{
  if(path==='/block-height/0')return '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
  if(path==='/fee-estimates')return '{"6":2}';
  if(path.endsWith('/utxo'))return JSON.stringify([{txid:parent.getId(),vout:0,value:100000,status:{confirmed:true}}]);
  if(path.endsWith('/hex'))return parent.toHex();if(path.includes('/outspend/'))return '{"spent":false}';
  if(path==='/tx'){raw=options.body;return Transaction.fromHex(raw).getId();}throw Error(path);
}});try{await f.w.action('create',{password});ownerScript=payments.p2wpkh({address:f.w.state().addresses.btc,network:networks.bitcoin}).output;parent=new Transaction();parent.addInput(Buffer.alloc(32,1),0);parent.addOutput(ownerScript,100000n);
  const p={network:'bitcoin',asset:'BTC',to:f.w.state().addresses.btc,amount:'0.0005'};
  await assert.rejects(f.w.action('prepare',{...p,to:f.w.state().addresses.btcTest}),/网络/);
  const d=await f.w.action('prepare',p);await f.w.action('send',{draftId:d.draftId,confirmation:'确认主网发送'});const tx=Transaction.fromHex(raw);
  assert.equal(tx.outs[0].value,50000n);assert.equal(tx.outs.length,2);assert.ok(tx.ins[0].witness.length===2);assert.equal(100000n-tx.outs.reduce((s,o)=>s+o.value,0n),BigInt(Math.round(Number(d.fee.split(' ')[0])*1e8)));
}finally{f.close();}});

test('DOGE signs a real P2PKH previous output, returns change and refuses a foreign address',async()=>{
  let parent,raw;
  const f=fixture({request:async(n,path,options)=>{
    if(path==='')return '{"medium_fee_per_kb":100000}';
    if(path.startsWith('/addrs/')&&path.includes('unspentOnly'))return JSON.stringify({txrefs:[{tx_hash:parent.getId(),tx_output_n:0,value:100000000,confirmations:6,spent:false}]});
    if(path.startsWith('/txs/')&&path.endsWith('includeHex=true'))return JSON.stringify({hex:parent.toHex()});
    if(path==='/txs/push'){raw=JSON.parse(options.body).tx;return JSON.stringify({tx:{hash:Transaction.fromHex(raw).getId()}});}
    throw Error(path);
  }});
  try{
    await f.w.action('create',{password});
    const owner=f.w.state().addresses;
    assert.match(owner.doge,/^D[1-9A-HJ-NP-Za-km-z]{25,34}$/,'doge address is base58 P2PKH');
    assert.notEqual(owner.doge,owner.btc,'doge and btc addresses differ');

    parent=new Transaction();
    parent.addInput(Buffer.alloc(32,1),0);
    parent.addOutput(payments.p2pkh({address:owner.doge,network:DOGE_CHAIN}).output,100000000n);

    // a Bitcoin address is not a Dogecoin address: must be refused before any signing
    await assert.rejects(()=>f.w.action('prepare',{network:'dogecoin',asset:'DOGE',to:owner.btc,amount:'0.5'}),/DOGE/);

    const draft=await f.w.action('prepare',{network:'dogecoin',asset:'DOGE',to:owner.doge,amount:'0.5'});
    assert.equal(draft.test,false,'dogecoin has no testnet in this version');
    await f.w.action('send',{draftId:draft.draftId,confirmation:'确认主网发送'});

    const tx=Transaction.fromHex(raw);
    assert.equal(tx.outs[0].value,50000000n,'recipient gets exactly 0.5 DOGE');
    assert.equal(tx.outs.length,2,'change output is kept');
    assert.equal(tx.ins[0].witness.length,0,'P2PKH spends carry no witness');
    assert.ok(tx.ins[0].script.length>0,'P2PKH scriptSig is present');
    assert.equal(tx.outs[1].value,100000000n-50000000n-BigInt(Math.round(Number(draft.fee.split(' ')[0])*1e8)),'change equals input minus amount minus fee');
  }finally{f.close();}
});
