import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Interface} from 'ethers';
import {NiuLab,decodeErc20TransferInput} from './lab.mjs';

const iface=new Interface([
  'function transfer(address to,uint256 value) returns (bool)',
  'function transferFrom(address from,address to,uint256 value) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)'
]);
const sender='0x'+'1'.repeat(40),recipient='0x'+'2'.repeat(40),spender='0x'+'3'.repeat(40),token='0x'+'4'.repeat(40);
const hash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64),raw=1000n*10n**6n;

function transferLog(from=sender,to=recipient){
  const encoded=iface.encodeEventLog(iface.getEvent('Transfer'),[from,to,raw]);
  return {address:token,topics:encoded.topics,data:encoded.data};
}

test('ERC-20 transfer and transferFrom inputs expose token participants and raw quantity',()=>{
  const direct=decodeErc20TransferInput(iface.encodeFunctionData('transfer',[recipient,raw]),sender,token);
  assert.deepEqual({method:direct.method,from:direct.from,to:direct.to,rawAmount:direct.rawAmount},{method:'transfer',from:sender,to:recipient,rawAmount:String(raw)});
  const delegated=decodeErc20TransferInput(iface.encodeFunctionData('transferFrom',[sender,recipient,raw]),spender,token);
  assert.deepEqual({method:delegated.method,from:delegated.from,to:delegated.to},{method:'transferFrom',from:sender,to:recipient});
  assert.equal(decodeErc20TransferInput('0x12345678',sender,token),null);
});

test('transaction details prefer confirmed Transfer events and format AGSP units',async()=>{
  const tx={hash,from:sender,to:token,value:0n,data:iface.encodeFunctionData('transfer',[recipient,raw]),nonce:1,type:0,
    gasLimit:49395n,gasPrice:2000000000n,chainId:26261017n,index:0,blockNumber:4264,blockHash};
  const receipt={status:1,blockNumber:4264,blockHash,index:0,gasUsed:49007n,gasPrice:2000000000n,logs:[transferLog()],contractAddress:null};
  const provider={getTransaction:async()=>tx,getTransactionReceipt:async()=>receipt,getBlockNumber:async()=>6547,getBlock:async()=>({timestamp:1792376039})};
  const lab=Object.create(NiuLab.prototype);
  Object.assign(lab,{providers:[provider],walletAddresses:[sender],meta:{transactions:[{hash,dir:'out',amount:'0'}],tokens:[]}});
  lab.tokenMetadata=async()=>({address:token,name:'AGSP Token',symbol:'AGSP',decimals:6,totalSupply:String(raw)});
  const details=await lab.transactionDetails(hash);
  assert.equal(details.amount,'0.0');
  assert.equal(details.assetType,'erc20');
  assert.equal(details.tokenTransfers.length,1);
  assert.equal(details.tokenTransfers[0].amount,'1000.0');
  assert.equal(details.tokenTransfers[0].symbol,'AGSP');
  assert.equal(details.tokenTransfers[0].method,'transfer');
  assert.equal(details.tokenTransfers[0].source,'event');
});

test('ledger scan recognizes an incoming ERC-20 recipient encoded inside calldata',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'niu-erc20-ledger-'));
  const tx={hash,from:sender,to:token,value:0n,data:iface.encodeFunctionData('transfer',[recipient,raw]),nonce:1,type:0,
    gasLimit:49395n,gasPrice:2000000000n,chainId:26261017n,index:0,blockNumber:1,blockHash};
  const receipt={status:1,blockNumber:1,blockHash,index:0,gasUsed:49007n,gasPrice:2000000000n,logs:[transferLog(sender,recipient)],contractAddress:null};
  const block={number:1,hash:blockHash,timestamp:1700000000,transactions:[hash],prefetchedTransactions:[tx]};
  const provider={getBlockNumber:async()=>1,getBalance:async()=>0n,getBlock:async()=>block,getTransaction:async()=>tx,getTransactionReceipt:async()=>receipt,
    send:async method=>({eth_mining:false,net_peerCount:'0x1',eth_syncing:false,admin_nodeInfo:{enode:'test'}}[method])};
  const lab=Object.create(NiuLab.prototype);
  Object.assign(lab,{ready:true,providers:[provider],walletAddresses:[recipient],meta:{transactions:[],tokens:[]},metaFile:join(dir,'activity.json'),base:dir});
  lab.tokenMetadata=async()=>({address:token,name:'AGSP Token',symbol:'AGSP',decimals:6,totalSupply:String(raw)});
  try{
    const state=await lab.state(),entry=state.transactions[0];
    assert.equal(state.transactions.length,1);
    assert.equal(entry.dir,'in');
    assert.equal(entry.counterparty,sender);
    assert.equal(entry.amount,'0.0');
    assert.equal(entry.tokenTransfers[0].amount,'1000.0');
    assert.equal(entry.tokenTransfers[0].symbol,'AGSP');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
