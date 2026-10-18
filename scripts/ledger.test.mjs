import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NiuLab} from './lab.mjs';

test('incoming ledger reads full transactions and does not duplicate a rescan',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'niu-ledger-'));
  const address='0x'+'1'.repeat(40),hash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64);
  const tx={hash,to:address,from:'0x'+'2'.repeat(40),value:12500000000000000000n,data:'0x',nonce:7,type:0,
    gasLimit:21000n,gasPrice:2000000000n,chainId:26261017n,index:0,blockNumber:1,blockHash};
  const block={number:1,hash:blockHash,timestamp:1700000000,transactions:[hash],prefetchedTransactions:[tx]};
  const p={getBlockNumber:async()=>1,getBalance:async()=>tx.value,getBlock:async()=>block,
    getTransaction:async()=>tx,
    getTransactionReceipt:async()=>({status:1,blockNumber:1,blockHash,index:0,gasUsed:21000n,gasPrice:2000000000n,logs:[],contractAddress:null}),
    send:async(method)=>({eth_mining:false,net_peerCount:'0x1',eth_syncing:false,admin_nodeInfo:{enode:'test'}}[method])};
  const lab=Object.create(NiuLab.prototype);
  Object.assign(lab,{ready:true,providers:[p],walletAddresses:[address],meta:{transactions:[]},metaFile:join(dir,'activity.json'),base:dir});
  try{
    let state=await lab.state();
    assert.equal(state.transactions.length,1);
    assert.equal(state.transactions[0].hash,hash);
    assert.equal(state.transactions[0].dir,'in');
    assert.equal(state.transactions[0].amount,'12.5');
    assert.equal(state.transactions[0].blockHash,blockHash);
    const details=await lab.transactionDetails(hash);
    assert.equal(details.from,tx.from);
    assert.equal(details.to,address);
    assert.equal(details.fee,'0.000042');
    assert.equal(details.nonce,7);
    assert.equal(details.transactionIndex,0);
    lab.meta.scannedTo=0;lab.lastLedgerScan=0;
    state=await lab.state();assert.equal(state.transactions.length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
