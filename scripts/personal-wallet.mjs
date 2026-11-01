import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {JsonRpcProvider,FetchRequest,Wallet,Contract,Interface,getAddress,formatUnits,keccak256} from 'ethers';
import {Psbt,Transaction,address,payments,networks} from 'bitcoinjs-lib';
import {ECPairFactory} from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import {PersonalVault} from './personal-vault.mjs';
import {NETWORKS,network,quantity,DOGE_CHAIN} from './personal-networks.mjs';
const pairs=ECPairFactory(ecc);
const abi=['function balanceOf(address) view returns (uint256)','function transfer(address,uint256) returns (bool)'];
const tokenInterface=new Interface(abi);
const genesis={bitcoin:'000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',bitcoinTest:'000000000933ea01ad0ee984209779baaec3ced90fa3f408719526f8d77f4943'};
const stringify=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v);
export class PersonalWallet{
  constructor(dir,{providerFactory,request}={}){
    this.dir=dir;this.vault=new PersonalVault(resolve(dir,'personal-vault.json'));this.drafts=new Map();this.busy=false;
    this.providerFactory=providerFactory||((n)=>{const r=new FetchRequest(n.rpc);r.timeout=12000;return new JsonRpcProvider(r,undefined,{batchMaxCount:1});});
    this.request=request||(async(n,path,options={})=>{const response=await fetch(n.api+path,{...options,signal:AbortSignal.timeout(12000)});const text=await response.text();if(!response.ok)throw Error('Bitcoin 数据服务请求失败（'+response.status+'）');if(text.length>4000000)throw Error('节点响应过大');return text;});
    this.historyFile=resolve(dir,'personal-history.json');
    this.history=existsSync(this.historyFile)?JSON.parse(readFileSync(this.historyFile,'utf8')):[];
    if(!Array.isArray(this.history))throw Error('个人钱包交易记录损坏，请保留文件后检查');
  }
  async exclusive(fn){if(this.busy)throw Error('另一个个人钱包操作正在处理中');this.busy=true;try{return await fn();}finally{this.busy=false;}}
  save(){mkdirSync(this.dir,{recursive:true});writeFileSync(this.historyFile+'.new',stringify(this.history),{mode:0o600});renameSync(this.historyFile+'.new',this.historyFile);}
  state(){return {created:this.vault.present(),locked:!this.vault.secret,addresses:this.vault.addresses,networks:Object.values(NETWORKS).map(({id,name,test,kind,tokens})=>({id,name,test,kind,assets:Object.keys(tokens)})),history:this.history.map(({raw,...entry})=>({...entry,explorer:network(entry.network).explorer+entry.hash}))};}
  lock(){this.vault.lock();this.drafts.clear();return this.state();}
  async action(action,data={}){return this.exclusive(async()=>{
    switch(action){
      case 'create':await this.vault.create(data.password);return this.state();
      case 'unlock':await this.vault.unlock(data.password);return this.state();
      case 'lock':return this.lock();
      case 'backup':return this.vault.backup(data.password);
      case 'restore':await this.vault.restore(data.content,data.password);return this.state();
      case 'balance':return this.balance(data.network);
      case 'prepare':return this.prepare(data);
      case 'send':return this.send(data.draftId,data.confirmation);
      case 'refresh':await this.refresh();return this.state();
      default:throw Error('未知个人钱包操作');
    }
  });}
  owner(n){if(!this.vault.addresses)throw Error('请先解锁个人钱包以读取地址');return n.kind==='evm'?this.vault.addresses.evm:n.kind==='doge'?this.vault.addresses.doge:n.test?this.vault.addresses.btcTest:this.vault.addresses.btc;}
  async evm(n,fn){const p=this.providerFactory(n);try{if(BigInt(await p.send('eth_chainId',[]))!==BigInt(n.chainId))throw Error('RPC 链 ID 不匹配，拒绝继续');return await fn(p);}finally{p.destroy?.();}}
  async btcCheck(n){if((await this.request(n,'/block-height/0')).trim()!==genesis[n.id])throw Error('Bitcoin 节点网络不匹配');}
  async balance(id){const n=network(id),owner=this.owner(n);
    // Each token is queried on its own: one bad contract or a throttled RPC call must not
    // wipe out the balance of the other tokens on the same network.
    if(n.kind==='evm')return this.evm(n,async p=>{const balances={},errors={};
      for(const [symbol,t]of Object.entries(n.tokens)){
        try{const value=t.address?await new Contract(t.address,abi,p).balanceOf(owner):await p.getBalance(owner);
          balances[symbol]=formatUnits(value,t.decimals);}
        catch(e){errors[symbol]=e.shortMessage||e.message||'查询失败';}
      }
      return {network:id,address:owner,balances,errors};});
    if(n.kind==='doge'){const info=JSON.parse(await this.request(n,'/addrs/'+owner+'/balance'));if(!Number.isSafeInteger(info.balance))throw Error('Dogecoin 余额响应无效');return {network:id,address:owner,balances:{DOGE:formatUnits(BigInt(info.balance),8)},pending:formatUnits(BigInt(info.unconfirmed_balance||0),8)};}
    await this.btcCheck(n);const info=JSON.parse(await this.request(n,'/address/'+owner));const c=info.chain_stats,m=info.mempool_stats;return {network:id,address:owner,balances:{BTC:formatUnits(BigInt(c.funded_txo_sum)-BigInt(c.spent_txo_sum),8)},pending:formatUnits(BigInt(m.funded_txo_sum)-BigInt(m.spent_txo_sum),8)};
  }
  async prepare(data){
    const secret=this.vault.require(),n=network(data.network),asset=n.tokens[data.asset];if(!asset)throw Error('该网络不支持这个资产');
    if(this.history.some(h=>h.network===n.id&&['broadcasting','unknown','pending'].includes(h.status)))throw Error('该网络已有待确认或广播结果未知的交易，请先刷新交易状态');
    const owner=this.owner(n),value=quantity(data.amount,asset.decimals);let draft;
    if(n.kind==='evm'){
      // ethers throws a bare "invalid address" here, which tells the user nothing useful.
      let to;try{to=getAddress(data.to);}catch{throw Error('收款地址格式不对：以太坊地址必须 0x 开头、共 42 个字符。建议用卡片上的「复制」按钮重新复制。');}
      if(to==='0x0000000000000000000000000000000000000000')throw Error('不允许发送到零地址');
      draft=await this.evm(n,async p=>{
        const req={from:owner,to:asset.address||to,value:asset.address?0n:value,data:asset.address?tokenInterface.encodeFunctionData('transfer',[to,value]):'0x'};
        const native=await p.getBalance(owner);
        if(asset.address){if(await new Contract(asset.address,abi,p).balanceOf(owner)<value)throw Error(data.asset+' 余额不足');}
        else if(native<value)throw Error('ETH 余额不足：当前可用 '+formatUnits(native,18)+' ETH，本次需要 '+data.amount+' ETH');
        let estimated;
        // A bare estimateGas failure surfaces as "missing revert data", which tells the user nothing.
        try{estimated=await p.estimateGas(req);}
        catch{throw Error('无法估算手续费：通常是 ETH 余额不足以同时支付金额和网络费');}
        const gasLimit=estimated+estimated/5n;
        const fees=await p.getFeeData();let fee;
        if(fees.maxFeePerGas!=null&&fees.maxPriorityFeePerGas!=null){req.type=2;req.maxFeePerGas=fees.maxFeePerGas;req.maxPriorityFeePerGas=fees.maxPriorityFeePerGas;fee=gasLimit*fees.maxFeePerGas;}
        else{if(!fees.gasPrice||fees.gasPrice<=0n)throw Error('无法取得有效手续费');req.type=0;req.gasPrice=fees.gasPrice;fee=gasLimit*fees.gasPrice;}
        if(fee<=0n||fee>10n**16n)throw Error('手续费超过本版每笔0.01 ETH上限或报价无效');
        if(await p.getBalance(owner)<fee+req.value)throw Error('ETH不足以支付转账金额及最高网络手续费');
        delete req.from;req.gasLimit=gasLimit;req.chainId=n.chainId;req.nonce=await p.getTransactionCount(owner,'pending');
        return {req,network:n.id,asset:data.asset,from:owner,to,amount:data.amount,fee:formatUnits(fee,18)+' ETH（最高）'};
      });
    }else if(n.kind==='doge'){
      // Dogecoin: P2PKH only, no SegWit, fees quoted per kB in koinu.
      let script;try{script=payments.p2pkh({address:data.to,network:DOGE_CHAIN}).output;}catch{throw Error('DOGE 收款地址无效或不是 Dogecoin 地址');}
      if(value<1000000n)throw Error('本版 DOGE 转账金额至少 0.01 DOGE');
      const chain=JSON.parse(await this.request(n,''));
      const rate=Math.ceil(Number(chain.medium_fee_per_kb)/1000);
      if(!Number.isFinite(rate)||rate<1||rate>200000)throw Error('DOGE 费率无效或超过本版上限');
      const info=JSON.parse(await this.request(n,'/addrs/'+owner+'?unspentOnly=true&limit=50'));
      const allUtxos=Array.isArray(info.txrefs)?info.txrefs:[];
      const utxos=allUtxos.filter(u=>u.confirmations>=1&&!u.spent);
      if(!utxos.length){
        const pending=allUtxos.filter(u=>!(u.confirmations>=1)&&!u.spent).reduce((a,u)=>a+BigInt(u.value||0),0n);
        throw Error(pending>0n
          ?'有 '+formatUnits(pending,8)+' DOGE 还未确认，等 1 次确认后才能转出。'
          :'没有已确认的 DOGE UTXO，无法转出。');
      }
      const ownScript=payments.p2pkh({pubkey:pairs.fromPrivateKey(Buffer.from(secret.btc,'hex')).publicKey,network:DOGE_CHAIN}).output;
      const selected=[];let sum=0n,fee=0n;const seen=new Set();
      for(const u of utxos.slice(0,40)){
        if(!/^[0-9a-f]{64}$/.test(u.tx_hash)||!Number.isInteger(u.tx_output_n)||u.tx_output_n<0||!Number.isSafeInteger(u.value)||u.value<=0)throw Error('DOGE UTXO 字段无效');
        const outId=u.tx_hash+':'+u.tx_output_n;if(seen.has(outId))throw Error('重复 UTXO');seen.add(outId);
        selected.push(u);sum+=BigInt(u.value);
        fee=BigInt(rate*(10+148*selected.length+34*2));
        if(sum>=value+fee)break;
      }
      if(sum<value+fee)throw Error('已确认 DOGE 余额不足（最多选择40个UTXO）');
      const psbt=new Psbt({network:DOGE_CHAIN,maximumFeeRate:1000000});
      for(const u of selected){
        const parent=Transaction.fromHex((JSON.parse(await this.request(n,'/txs/'+u.tx_hash+'?includeHex=true'))).hex);
        const out=parent.outs[u.tx_output_n];
        if(parent.getId()!==u.tx_hash||!out||out.value!==BigInt(u.value)||!Buffer.from(out.script).equals(Buffer.from(ownScript)))throw Error('DOGE 前序交易与 UTXO 不匹配，拒绝签名');
        psbt.addInput({hash:u.tx_hash,index:u.tx_output_n,nonWitnessUtxo:parent.toBuffer(),sequence:0xfffffffe});
      }
      psbt.addOutput({address:data.to,value});
      let change=sum-value-fee;
      if(change>=1000000n)psbt.addOutput({address:owner,value:change});else{fee+=change;change=0n;}
      if(fee>500000000n)throw Error('DOGE 手续费超过本版每笔5 DOGE上限');
      draft={network:n.id,asset:'DOGE',from:owner,to:data.to,amount:data.amount,fee:formatUnits(fee,8)+' DOGE',psbt:psbt.toBase64(),feeSat:fee,rate,inputs:selected.map(u=>({txid:u.tx_hash,vout:u.tx_output_n}))};
    }else{
      const net=n.test?networks.testnet:networks.bitcoin;let script;try{script=address.toOutputScript(data.to,net);}catch{throw Error('BTC收款地址无效或网络不匹配');}
      if(value<546n)throw Error('本版BTC转账金额至少546 sat');
      await this.btcCheck(n);const rates=JSON.parse(await this.request(n,'/fee-estimates'));const rate=Math.ceil(Number(rates['6']));if(!Number.isFinite(rate)||rate<1||rate>1000)throw Error('BTC费率无效或超过1000 sat/vB上限');
      const utxos=JSON.parse(await this.request(n,'/address/'+owner+'/utxo'));
      if(!Array.isArray(utxos))throw Error('UTXO响应无效');
      const selected=[];let sum=0n,fee=0n;const seen=new Set();
      for(const u of utxos.filter(u=>u.status?.confirmed).slice(0,40)){
        if(!/^[0-9a-f]{64}$/.test(u.txid)||!Number.isInteger(u.vout)||u.vout<0||!Number.isSafeInteger(u.value)||u.value<=0)throw Error('UTXO字段无效');
        const id=u.txid+':'+u.vout;if(seen.has(id))throw Error('重复UTXO');seen.add(id);
        selected.push(u);sum+=BigInt(u.value);fee=BigInt(rate*(12+69*selected.length+31+9+script.length));if(sum>=value+fee)break;
      }
      if(sum<value+fee){
        // "not enough balance" is misleading when the money is there but still unconfirmed.
        const unconfirmed=utxos.filter(u=>!u.status?.confirmed).reduce((a,u)=>a+BigInt(u.value||0),0n);
        throw Error(unconfirmed>0n
          ?'已确认的 BTC 余额不足。另有 '+formatUnits(unconfirmed,8)+' BTC 还未确认，等 1 次确认后才能转出。'
          :'已确认的 BTC 余额不足（本版最多选择 40 个 UTXO）。');
      }
      const pair=pairs.fromPrivateKey(Buffer.from(secret.btc,'hex'));const ownScript=payments.p2wpkh({pubkey:pair.publicKey,network:net}).output;
      const psbt=new Psbt({network:net});
      for(const u of selected){const parent=Transaction.fromHex((await this.request(n,'/tx/'+u.txid+'/hex')).trim());const out=parent.outs[u.vout];if(parent.getId()!==u.txid||!out||out.value!==BigInt(u.value)||!Buffer.from(out.script).equals(Buffer.from(ownScript)))throw Error('BTC前序交易与UTXO不匹配，拒绝签名');psbt.addInput({hash:u.txid,index:u.vout,nonWitnessUtxo:parent.toBuffer(),witnessUtxo:{script:out.script,value:out.value},sequence:0xfffffffe});}
      psbt.addOutput({address:data.to,value});let change=sum-value-fee;if(change>=546n)psbt.addOutput({address:owner,value:change});else{fee+=change;change=0n;}
      if(fee>100000n)throw Error('BTC手续费超过本版每笔0.001 BTC上限');
      draft={network:n.id,asset:'BTC',from:owner,to:data.to,amount:data.amount,fee:formatUnits(fee,8)+' BTC',psbt:psbt.toBase64(),feeSat:fee,rate,inputs:selected};
    }
    const id=randomUUID();this.drafts.clear();draft.id=id;draft.expires=Date.now()+90000;this.drafts.set(id,draft);
    return {draftId:id,network:n.name,test:n.test,from:draft.from,to:draft.to,asset:draft.asset,amount:draft.amount,fee:draft.fee,expires:draft.expires};
  }
  async send(id,confirmation){
    const secret=this.vault.require(),d=this.drafts.get(id);this.drafts.delete(id);if(!d||Date.now()>d.expires)throw Error('转账预览已过期，请重新预览');const n=network(d.network);
    if(confirmation!==(n.test?'确认测试网发送':'确认主网发送'))throw Error('请完成对应网络的转账确认');
    let raw,hash;
    if(n.kind==='evm'){
      await this.evm(n,async p=>{if(await p.getTransactionCount(d.from,'pending')!==d.req.nonce)throw Error('账户nonce已变化，请重新预览');const req={...d.req,from:d.from};if(await p.getBalance(d.from)<d.req.value+d.req.gasLimit*(d.req.maxFeePerGas??d.req.gasPrice))throw Error('余额已变化，请重新预览');if(await p.estimateGas(req)>d.req.gasLimit)throw Error('所需gas已变化，请重新预览');});
      raw=await new Wallet(secret.evm).signTransaction(d.req);hash=keccak256(raw);
    }else if(n.kind==='doge'){
      const info=JSON.parse(await this.request(n,'/addrs/'+d.from+'?unspentOnly=true&limit=50'));
      const live=new Set((Array.isArray(info.txrefs)?info.txrefs:[]).filter(u=>u.confirmations>=1&&!u.spent).map(u=>u.tx_hash+':'+u.tx_output_n));
      for(const u of d.inputs)if(!live.has(u.txid+':'+u.vout))throw Error('DOGE UTXO 已花费或状态不明，请重新预览');
      const psbt=Psbt.fromBase64(d.psbt,{network:DOGE_CHAIN,maximumFeeRate:1000000});
      psbt.signAllInputs(pairs.fromPrivateKey(Buffer.from(secret.btc,'hex')));
      if(!psbt.validateSignaturesOfAllInputs((pub,hash,sig)=>ecc.verify(hash,pub,sig)))throw Error('DOGE 签名校验失败');
      psbt.finalizeAllInputs();const tx=psbt.extractTransaction();
      if(Number(d.feeSat)<d.rate*tx.virtualSize())throw Error('DOGE 交易体积变化，请重新预览');
      raw=tx.toHex();hash=tx.getId();
    }else{
      await this.btcCheck(n);for(const u of d.inputs){const spent=JSON.parse(await this.request(n,'/tx/'+u.txid+'/outspend/'+u.vout));if(spent.spent!==false)throw Error('UTXO已花费或状态不明，请重新预览');}
      const psbt=Psbt.fromBase64(d.psbt,{network:n.test?networks.testnet:networks.bitcoin});psbt.signAllInputs(pairs.fromPrivateKey(Buffer.from(secret.btc,'hex')));
      if(!psbt.validateSignaturesOfAllInputs((pub,hash,sig)=>ecc.verify(hash,pub,sig)))throw Error('BTC签名校验失败');psbt.finalizeAllInputs();const tx=psbt.extractTransaction();if(Number(d.feeSat)<d.rate*tx.virtualSize())throw Error('BTC交易体积变化，请重新预览');raw=tx.toHex();hash=tx.getId();
    }
    const entry={id:randomUUID(),network:d.network,asset:d.asset,from:d.from,to:d.to,amount:d.amount,fee:d.fee,hash,raw,status:'broadcasting',createdAt:new Date().toISOString(),explorer:n.explorer+hash};
    this.history.unshift(entry);this.save();
    try{
      const result=n.kind==='evm'
        ?await this.evm(n,p=>p.send('eth_sendRawTransaction',[raw]))
        :n.kind==='doge'
          ?String(JSON.parse(await this.request(n,'/txs/push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tx:raw})}))?.tx?.hash||'')
          :(await this.request(n,'/tx',{method:'POST',headers:{'content-type':'text/plain'},body:raw})).trim();
      if(result.toLowerCase()!==hash.toLowerCase())throw Error('节点返回的交易哈希不匹配');entry.status='pending';this.save();return {hash,status:entry.status,explorer:entry.explorer};
    }catch{entry.status='unknown';this.save();throw Error('广播结果未知，请刷新此交易状态；不要重复转账。交易哈希：'+hash);}
  }
  async refresh(){for(const h of this.history.filter(h=>['broadcasting','pending','unknown'].includes(h.status))){const n=network(h.network);try{
    if(n.kind==='evm')await this.evm(n,async p=>{const r=await p.send('eth_getTransactionReceipt',[h.hash]);if(r){h.status=BigInt(r.status)===1n?'confirmed':'failed';h.block=Number(BigInt(r.blockNumber));}else if(await p.send('eth_getTransactionByHash',[h.hash]))h.status='pending';});
    else if(n.kind==='doge'){const t=JSON.parse(await this.request(n,'/txs/'+h.hash));h.status=Number(t.confirmations)>0?'confirmed':'pending';h.block=t.block_height??null;}
    else{await this.btcCheck(n);const s=JSON.parse(await this.request(n,'/tx/'+h.hash+'/status'));h.status=s.confirmed?'confirmed':'pending';h.block=s.block_height??null;}
  }catch{/* Unreachable nodes never turn an unknown broadcast into a failed send. */}}this.save();}
}
