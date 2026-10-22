import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,createWriteStream,unlinkSync,statSync} from 'node:fs';
import net from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Wallet,JsonRpcProvider,ContractFactory,Contract,Interface,isAddress,getAddress,parseEther,parseUnits,formatEther,formatUnits} from 'ethers';
import solc from 'solc';
import {exportPortable,importPortable} from './portable-vault.mjs';
import {loadNetwork,p2pConfig,syncPending} from './network.mjs';
import {NiuProvider} from './local-provider.mjs';
import {crypt,walletProtection} from './vault-crypto.mjs';
import {ContractStudio,ERC20_ABI} from './contract-studio.mjs';
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const CHAIN_ID=26261015;
export const LOCK_IDLE_MS=5*60*1000;   // auto-lock the vault after 5 minutes without a signing action
export const TRANSACTION_LIMIT=200;    // ledger entries kept in activity.json (incoming + outgoing)
const UINT256_MAX=(1n<<256n)-1n;
const ERC20_TRANSFER_INTERFACE=new Interface([
  'function transfer(address to,uint256 value) returns (bool)',
  'function transferFrom(address from,address to,uint256 value) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)'
]);
const TOKEN_METADATA_TTL_MS=5*60*1000;

export function decodeErc20TransferInput(data,caller,contract){
  if(typeof data!=='string'||data.length<10||!contract)return null;
  try{
    const parsed=ERC20_TRANSFER_INTERFACE.parseTransaction({data});
    if(!parsed||!['transfer','transferFrom'].includes(parsed.name))return null;
    const from=parsed.name==='transferFrom'?getAddress(parsed.args[0]):getAddress(caller);
    const to=getAddress(parsed.name==='transfer'?parsed.args[0]:parsed.args[1]);
    const rawAmount=String(parsed.name==='transfer'?parsed.args[1]:parsed.args[2]);
    return {contract:getAddress(contract),from,to,rawAmount,method:parsed.name,source:'input'};
  }catch{return null;}
}
// geth only persists the dirty trie state -- the chain head state -- during an
// orderly shutdown. Killing the process before that flush completes loses it:
// the next start logs "Head state missing", falls back to the genesis head and
// then reports height 0 with a peer connected, which is indistinguishable from
// an emptied chain on first inspection. Give the flush a real deadline.
export const SHUTDOWN_GRACE_MS=120000;
const LOCK_SALT='niu-wallet-vault-v1';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function waitFor(label,fn,timeout=180000){
  const end=Date.now()+timeout;let error;
  while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){error=e;}
    await sleep(500);}
  throw Error(`${label}超时${error?`：${error.shortMessage||error.message}`:''}`);
}
function save(file,value){writeFileSync(file+'.new',JSON.stringify(value,null,2));renameSync(file+'.new',file);}
export class NiuLab {
  constructor({base=process.env.NIU_DATA_DIR||resolve(ROOT,'runtime/persistent'),ports=[18645,18646],p2p=[30471,30472],auth=[18651,18652],network=loadNetwork(ROOT),nodeBin}={}){
    this.base=base;this.ports=ports;this.p2p=p2p;this.auth=auth;this.children=[];this.logs=[];this.providers=[];
    this.nodeBin=nodeBin;this.ready=false;this.miningUntil=null;this.timer=null;this.busy=false;this.stopping=false;
    this.wallets=[];this.walletAddresses=[];this.locked=true;
    this.contractStudio=new ContractStudio(ROOT);this.tokenDrafts=new Map();
    this.network=network;
    if(this.network){this.ports=ports.slice(0,1);this.p2p=p2p.slice(0,1);this.auth=auth.slice(0,1);}
  }
  async start(){
    mkdirSync(this.base,{recursive:true});
    this.lockFile=resolve(this.base,'lab.lock');
    if(existsSync(this.lockFile)){
      const pid=Number(readFileSync(this.lockFile,'utf8'));
      let live=true;try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')live=false;}
      if(live)throw Error('此数据目录已被另一个牛链进程使用');
      unlinkSync(this.lockFile);
    }
    writeFileSync(this.lockFile,String(process.pid),{flag:'wx'});this.ownsLock=true;
    try {
    for(const port of [...this.ports,...this.p2p,...this.auth])await new Promise((ok,fail)=>{
      const probe=net.createServer();probe.once('error',()=>fail(Error(`端口${port}已被占用，未启动节点`)));
      probe.listen(port,'127.0.0.1',()=>probe.close(ok));
    });
    this.walletFile=resolve(this.base,'wallet.dpapi');
    if(!existsSync(this.walletFile)){
      // Do not replace lost keys when an existing chain is present.
      if(existsSync(resolve(this.base,'node1/geth/chaindata')))throw Error('已有链数据但钱包文件缺失，请先恢复wallet.dpapi备份。');
      const secret=Buffer.from(JSON.stringify({version:1,keys:[Wallet.createRandom().privateKey,Wallet.createRandom().privateKey]}));
      try{writeFileSync(this.walletFile,crypt('protect',secret).toString('base64'),{flag:'wx'});}finally{secret.fill(0);}
    }
    // Keys stay encrypted at rest and are never decrypted at startup. The vault
    // opens only after an explicit unlock, and re-locks itself after idle time
    // so an unattended machine does not hold private keys in memory.
    this.locked=true;this.wallets=[];this.unlockTimer=null;
    const decrypted=crypt('unprotect',Buffer.from(readFileSync(this.walletFile,'utf8'),'base64'));
    try{
      const vault=JSON.parse(decrypted.toString());
      if(vault.version!==1||!Array.isArray(vault.keys)||vault.keys.length<2||vault.keys.length>32)throw Error('钱包格式不兼容');
      this.walletAddresses=vault.keys.map(k=>new Wallet(k).address);
      this.checkHash=createHash('sha256').update(`${LOCK_SALT}:${this.walletAddresses.join(',')}`).digest('hex');
    }finally{decrypted.fill(0);}
    const configFile=resolve(this.base,'genesis.json');
    const genesis={config:{chainId:CHAIN_ID,homesteadBlock:0,eip150Block:0,eip155Block:0,eip158Block:0,
      byzantiumBlock:0,constantinopleBlock:0,petersburgBlock:0,istanbulBlock:0,muirGlacierBlock:0,
      berlinBlock:0,londonBlock:0,arrowGlacierBlock:0,grayGlacierBlock:0,ethash:{}},
      nonce:'0x0',timestamp:'0x0',extraData:'0x4e4955206c6f63616c20506f57206c6162207631',gasLimit:'0x1c9c380',
      difficulty:'0x20000',alloc:{},baseFeePerGas:'0x3b9aca00'};
    if(this.network){
      const candidate=JSON.parse(readFileSync(resolve(ROOT,'network/genesis.json'),'utf8'));
      if(candidate.config.chainId!==this.network.chainId||Object.keys(candidate.alloc||{}).length)throw Error('牛链创世配置无效或包含预分配');
      for(const key of Object.keys(genesis))delete genesis[key];Object.assign(genesis,candidate);
    }
    if(!existsSync(configFile))save(configFile,genesis);
    else if(JSON.stringify(JSON.parse(readFileSync(configFile)))!==JSON.stringify(genesis))throw Error('创世配置与当前程序不同，已停止，防止混用网络。');
    this.metaFile=resolve(this.base,'activity.json');
    this.meta=existsSync(this.metaFile)?JSON.parse(readFileSync(this.metaFile)): {transactions:[],contract:null};
    if(!Array.isArray(this.meta.tokens))this.meta.tokens=[];
    if(!Array.isArray(this.meta.developerContracts))this.meta.developerContracts=[];
    try{
      for(let i=0;i<this.ports.length;i++){
        const nodeName=(this.network?'niu-geth-candidate':'geth')+(process.platform==='win32'?'.exe':'');
        let fallback=resolve(ROOT,'bin',nodeName);
        if(process.platform==='darwin'&&!existsSync(fallback)&&existsSync(fallback+'.exe'))fallback+='.exe';
        const datadir=resolve(this.base,`node${i+1}`),exe=this.nodeBin||process.env.NIU_NODE_BIN||fallback;
        if(!existsSync(exe))throw Error('缺少与牛链规则匹配的节点程序，拒绝使用上游程序替代');
        const init=spawnSync(exe,['--datadir',datadir,'init',configFile],{encoding:'utf8',windowsHide:true});
        writeFileSync(resolve(this.base,`init${i+1}.log`),(init.stdout||'')+(init.stderr||''));
        if(init.status!==0)throw Error(`节点${i+1}初始化失败，详见日志。`);
        const args=['--datadir',datadir,'--networkid',String(this.network?.networkId||CHAIN_ID),'--nodiscover','--nat',this.network?.advertiseIP?`extip:${this.network.advertiseIP}`:'none',
          '--port',String(this.p2p[i]),'--maxpeers','16','--syncmode','full','--gcmode','archive',
          '--http','--http.addr','127.0.0.1','--http.port',String(this.ports[i]),'--http.api','eth,net,web3',
          '--http.vhosts','localhost,127.0.0.1','--ipcpath',this.ipcPath(i),'--authrpc.addr','127.0.0.1','--authrpc.port',String(this.auth[i]),
          '--miner.etherbase',this.walletAddresses[0],'--miner.gasprice','1000000000',
          '--ethash.dagdir',resolve(this.base,'ethash'),'--cache','128','console'];
        if(this.network){const cfg=resolve(this.base,'node.toml');writeFileSync(cfg,p2pConfig(this.network,this.p2p[i]));args.unshift('--config',cfg);}
        if(!this.network||this.network.restrictPeerIPs)args.unshift('--netrestrict',['127.0.0.0/8',...(this.network?.peerIPs||[]).map(ip=>ip+'/32')].join(','));
        const out=createWriteStream(resolve(this.base,`node${i+1}.log`),{flags:'a'});this.logs.push(out);
        const child=spawn(exe,args,{windowsHide:true});this.children.push(child);
        child.stdout.pipe(out,{end:false});child.stderr.pipe(out,{end:false});
        child.on('error',()=>{this.ready=false;});
        child.on('exit',()=>{if(!this.stopping)this.ready=false;});
      }
      this.armAutoLock();
      // Allow the node processes to bind before providers begin their network detection.
      await sleep(2000);
      this.providers=this.ports.map((port,i)=>new NiuProvider(port,this.ipcPath(i)));
      await Promise.all(this.providers.map((p,i)=>waitFor('节点启动',async()=>{
        if(this.children[i].exitCode!==null)throw Error('节点启动失败');
        const version=await p.send('web3_clientVersion',[]);
        if(this.network&&!version.includes('niu-rules1-candidate'))throw Error('节点程序不是牛链规则版本');
        return version;
      },45000)));
      if(!this.network){
        const info=await this.providers[0].send('admin_nodeInfo',[]);
        await this.providers[1].send('admin_addPeer',[info.enode.replace(/@[^:]+:/,'@127.0.0.1:')]);
        await waitFor('两节点互联',async()=>Number(await this.providers[1].send('net_peerCount',[]))===1);
      }
      this.genesisHash=(await this.providers[0].getBlock(0)).hash;
      for(const p of this.providers){
        if(Number((await p.getNetwork()).chainId)!==(this.network?.chainId||CHAIN_ID)||(await p.getBlock(0)).hash!==this.genesisHash||
          (this.network&&this.genesisHash.toLowerCase()!==this.network.genesisHash.toLowerCase()))throw Error('节点网络不匹配');
      }
      await this.recoverHead();
      this.ready=true;
    }catch(e){await this.close();throw e;}
    } catch(e){if(this.ownsLock){try{unlinkSync(this.lockFile);}catch{}this.ownsLock=false;}throw e;}
  }
  // A killed node loses its un-flushed head state and geth re-anchors the head
  // at genesis, which reads exactly like an emptied chain. The block data
  // survives, and with --gcmode archive the historical states do too: re-point
  // the head at the deepest block whose state is still readable. Never silently
  // continue with a shorter chain -- report the outcome either way.
  async recoverHead(){
    const last=Math.floor(Number(this.meta&&this.meta.lastBlock||0));
    if(!(last>0))return;
    const p=this.providers[0];
    const head=Number(await p.getBlockNumber());
    if(head>=last)return;
    const probe=last-head>20000?last-20000:head+1;
    let target=0;
    for(let n=last;n>=probe;n--){
      try{await p.send('eth_getBalance',[this.walletAddresses[0],'0x'+n.toString(16)]);target=n;break;}catch{}
    }
    if(target>head){
      for(const q of this.providers){
        await q.send('debug_setHead',['0x'+target.toString(16)]);
        if(Number(await q.getBlockNumber())!==target)throw Error('链头恢复校验失败');
      }
      this.chainRecovered={from:head,to:target};
    }else this.chainReset={last,head};
  }
  async exclusive(fn){
    if(!this.ready)throw Error('节点尚未就绪');
    if(this.busy)throw Error('上一项操作仍在处理中，请等待确认');
    this.busy=true;try{return await fn();}finally{this.busy=false;}
  }
  // Vault lock: private keys are decrypted only for signing and dropped again
  // after an idle window. The DPAPI file stays encrypted on disk at all times.
  armAutoLock(){
    clearTimeout(this.unlockTimer);
    if(this.locked)return;
    this.unlockTimer=setTimeout(()=>{this.lock();},LOCK_IDLE_MS);
    if(this.unlockTimer.unref)this.unlockTimer.unref();
  }
  lock(){
    if(!this.locked){
      for(const w of this.wallets){try{w.provider=null;}catch{}}
      this.wallets=[];
      this.locked=true;
    }
    clearTimeout(this.unlockTimer);this.unlockTimer=null;
  }
  // Unlock gate. Note the boundary honestly: the private keys are sealed by
  // Windows DPAPI against the OS user account, and this password is a local
  // lock-out gate, not the key-encryption secret. Anything able to run code as
  // the same Windows user can still reach the DPAPI-protected file. The gate
  // stops an unattended or borrowed session, not a compromised user account.
  async unlock(password){
    if(typeof password!=='string'||password.length<12||password.length>256)throw Error('钱包口令至少12个字符');
    const decrypted=crypt('unprotect',Buffer.from(readFileSync(this.walletFile,'utf8'),'base64'));
    let wallets=[];
    try{
      const vault=JSON.parse(decrypted.toString());
      if(vault.version!==1||!Array.isArray(vault.keys))throw Error('钱包格式不兼容');
      const candidate=createHash('sha256').update(`${LOCK_SALT}:${vault.keys.map(k=>new Wallet(k).address).join(',')}`).digest('hex');
      if(candidate!==this.checkHash)throw Error('钱包文件与本程序记录不一致');
      wallets=vault.keys.map(k=>new Wallet(k));
      if(new Set(wallets.map(w=>w.address)).size!==wallets.length)throw Error('钱包包含重复账户');
    }finally{decrypted.fill(0);}
    this.wallets=wallets;this.locked=false;this.armAutoLock();
    return {addresses:wallets.map(w=>w.address)};
  }  requireUnlocked(){
    if(this.locked||!this.wallets.length)throw Error('钱包已锁定，请先输入钱包口令解锁');
    this.armAutoLock();
    return this.wallets;
  }
  ipcPath(index){
    const id=createHash('sha256').update(resolve(this.base,`node${index+1}`)).digest('hex').slice(0,24);
    return process.platform==='win32'?`\\\\.\\pipe\\niu-${id}`:resolve(this.base,`node${index+1}/niu.ipc`);
  }
  async mine(enabled){
    if(!this.ready)throw Error('节点未就绪');
    if(enabled){
      if(syncPending(await this.providers[0].send('eth_syncing',[])))throw Error('区块同步尚未完成，请稍后开始挖矿');
      if(this.network&&!this.network.coordinator&&Number(await this.providers[0].send('net_peerCount',[]))===0)throw Error('没有连接到其他节点，不能开始挖矿');
      // The coordinator usually shares its machine with other services, so it seals
      // on a single thread. Desktop users keep two.
      const threads=(this.network&&this.network.coordinator)?1:2;
      await this.providers[0].send('miner_start',[threads]);
      // Mining now runs until the user stops it. The old fixed 10-minute desktop
      // window silently halted sealing, and once sealing stops no further blocks
      // are produced, so every pending transaction stayed unconfirmed forever.
      this.miningUntil=null;
      clearTimeout(this.timer);
    }else{await this.providers[0].send('miner_stop',[]);this.miningUntil=null;clearTimeout(this.timer);}
    return {mining:enabled,until:this.miningUntil};
  }
  async confirmed(tx,kind){
    const item={hash:tx.hash,kind,status:'pending',dir:'out',from:tx.from||'',to:tx.to||'',amount:formatEther(tx.value??0n),at:new Date().toISOString(),call:!!tx.data&&tx.data!=='0x'};
    if(item.call)this.attachTokenTransfers(item,await this.erc20Transfers(tx,null));
    this.meta.transactions.unshift(item);
    this.meta.transactions=this.meta.transactions.slice(0,TRANSACTION_LIMIT);save(this.metaFile,this.meta);
    const r=await waitFor('交易确认（需要开启挖矿）',()=>this.providers[0].getTransactionReceipt(tx.hash),240000);
    item.status=r.status===1?'confirmed':'failed';item.block=r.blockNumber;
    if(item.call){
      const transfers=await this.erc20Transfers(tx,r);this.attachTokenTransfers(item,transfers);item.assetChecked=true;
    }
    save(this.metaFile,this.meta);
    if(r.status!==1)throw Error('交易执行失败');
    if(this.providers[1])await waitFor('第二节点同步交易',()=>this.providers[1].getTransactionReceipt(tx.hash));
    return r;
  }
  async requireMining(){
    if(syncPending(await this.providers[0].send('eth_syncing',[])))throw Error('节点仍在同步，暂时不能发送交易');
    if(this.network){if(!Number(await this.providers[0].send('net_peerCount',[]))&&!await this.providers[0].send('eth_mining',[]))throw Error('节点未联网，也没有本地矿工');}
    else if(!await this.providers[0].send('eth_mining',[]))throw Error('请先开启挖矿，交易需要矿工打包');
  }
  async transfer(to,amount,from){return this.exclusive(async()=>{
    const unlocked=this.requireUnlocked();
    if(!isAddress(to)||/^0x0{40}$/i.test(to))throw Error('收款地址格式不正确');
    if(typeof amount!=='string'||!/^\d+(\.\d{1,18})?$/.test(amount)||amount.length>60)throw Error('请输入有效的NIU数量，最多18位小数');
    const value=parseEther(amount);if(value<=0n)throw Error('转账数量必须大于0');
    await this.requireMining();
    if(await this.providers[0].getCode(to)!=='0x')throw Error('首版转账仅支持普通钱包地址，合约交互请使用留言区');
    const source=from===undefined?unlocked[0]:unlocked.find(w=>w.address.toLowerCase()===String(from).toLowerCase());
    if(!source)throw Error('发送账户不属于当前钱包');
    const signer=source.connect(this.providers[0]);
    if(await this.providers[0].getBalance(signer.address)<value+21000n*2000000000n)throw Error('余额不足，请先获得NIU，并预留手续费');
    const tx=await signer.sendTransaction({to,value,gasLimit:21000,gasPrice:2000000000n,type:0});
    const r=await this.confirmed(tx,'转账');return {hash:tx.hash,block:r.blockNumber};
  });}
  artifact(){
    if(this.compiled)return this.compiled;
    const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'NiuGuestbook.sol':{content:readFileSync(resolve(ROOT,'contracts/NiuGuestbook.sol'),'utf8')}},
      settings:{evmVersion:'london',optimizer:{enabled:true,runs:200},outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
    if((output.errors||[]).some(x=>x.severity==='error'))throw Error('合约编译失败');
    return this.compiled=output.contracts['NiuGuestbook.sol'].NiuGuestbook;
  }
  async deploy(message){return this.exclusive(async()=>{
    this.requireUnlocked();this.validMessage(message);if(this.meta.contract)throw Error('已有留言合约，请直接更新留言');await this.requireMining();
    const a=this.artifact();const c=await new ContractFactory(a.abi,a.evm.bytecode.object,this.requireUnlocked()[0].connect(this.providers[0]))
      .deploy(message,{gasPrice:2000000000n,type:0});
    const tx=c.deploymentTransaction();
    // Persist pending deployment address before waiting; restart can recover a confirmed deployment.
    this.meta.contract={address:await c.getAddress(),deployHash:tx.hash};save(this.metaFile,this.meta);
    await this.confirmed(tx,'部署合约');return this.meta.contract;
  });}
  validMessage(message){if(typeof message!=='string'||!message.trim()||Buffer.byteLength(message)>512)throw Error('留言不能为空，最多512字节');}
  async update(message){return this.exclusive(async()=>{
    this.requireUnlocked();this.validMessage(message);if(!this.meta.contract)throw Error('请先部署留言合约');await this.requireMining();
    const c=new Contract(this.meta.contract.address,this.artifact().abi,this.requireUnlocked()[0].connect(this.providers[0]));
    const tx=await c.setMessage(message,{gasPrice:2000000000n,type:0});await this.confirmed(tx,'更新留言');return {hash:tx.hash};
  });}
  signer(from){
    const wallets=this.requireUnlocked();
    const wallet=from===undefined||from===null||from===''?wallets[0]:wallets.find(item=>item.address.toLowerCase()===String(from).toLowerCase());
    if(!wallet)throw Error('签名账户不属于当前钱包');
    return wallet.connect(this.providers[0]);
  }
  contractArgs(args){
    if(!Array.isArray(args)||args.length>32)throw Error('构造参数或函数参数必须是最多32项的JSON数组');
    const size=Buffer.byteLength(JSON.stringify(args,(_key,item)=>typeof item==='bigint'?item.toString():item));
    if(size>65536)throw Error('合约参数不能超过64KB');
    return args;
  }
  contractValue(value){
    const text=value===undefined||value===null||value===''?'0':String(value);
    if(!/^\d+(\.\d{1,18})?$/.test(text)||text.length>60)throw Error('附带NIU数量格式不正确');
    return parseEther(text);
  }
  contractResult(value){
    if(typeof value==='bigint')return value.toString();
    if(Array.isArray(value))return Array.from(value,item=>this.contractResult(item));
    if(value&&typeof value==='object'){
      if(typeof value.toHexString==='function')return value.toHexString();
      const out={};for(const [key,item] of Object.entries(value))if(!/^\d+$/.test(key))out[key]=this.contractResult(item);
      return Object.keys(out).length?out:String(value);
    }
    return value;
  }
  compileSolidity(source,fileName){return this.contractStudio.compile(source,fileName);}
  deploymentSpec(buildId,contractName,args,from,value){
    const {build,artifact}=this.contractStudio.artifact(buildId,contractName);
    return {build,artifact,args:this.contractArgs(args),signer:this.signer(from),value:this.contractValue(value)};
  }
  async deploymentEstimate(buildId,contractName,args,from,value){
    const spec=this.deploymentSpec(buildId,contractName,args,from,value);
    const factory=new ContractFactory(spec.artifact.abi,spec.artifact.bytecode,spec.signer);
    const request=await factory.getDeployTransaction(...spec.args,{value:spec.value,gasPrice:2000000000n,type:0});
    const gas=await spec.signer.estimateGas(request),fee=gas*2000000000n;
    return {gas:String(gas),gasPriceGwei:'2',estimatedFeeNIU:formatEther(fee),bytecodeBytes:spec.artifact.bytecodeBytes};
  }
  async deployCompiled(buildId,contractName,args,from,value,label){return this.exclusive(async()=>{
    const spec=this.deploymentSpec(buildId,contractName,args,from,value);await this.requireMining();
    if(this.meta.developerContracts.length>=20)throw Error('最多保存20个合约，请先备份并整理合约记录');
    const factory=new ContractFactory(spec.artifact.abi,spec.artifact.bytecode,spec.signer);
    const request=await factory.getDeployTransaction(...spec.args,{value:spec.value,gasPrice:2000000000n,type:0});
    const estimate=await spec.signer.estimateGas(request),gasLimit=estimate+estimate/5n;
    const contract=await factory.deploy(...spec.args,{value:spec.value,gasPrice:2000000000n,gasLimit,type:0});
    const tx=contract.deploymentTransaction(),address=await contract.getAddress();
    const record={id:randomUUID(),name:String(label||contractName).trim().slice(0,80)||contractName,contractName,address,
      abi:spec.artifact.abi,sourceHash:spec.build.sourceHash,deployHash:tx.hash,createdAt:new Date().toISOString(),pending:true};
    this.meta.developerContracts.unshift(record);save(this.metaFile,this.meta);
    try{const receipt=await this.confirmed(tx,`部署合约 ${contractName}`);record.pending=false;record.block=receipt.blockNumber;save(this.metaFile,this.meta);return {id:record.id,address,hash:tx.hash,block:receipt.blockNumber};}
    catch(e){record.pending=false;record.failed=true;save(this.metaFile,this.meta);throw e;}
  });}
  contractRecord(id){
    const record=(this.meta.developerContracts||[]).find(item=>item.id===id);
    if(!record)throw Error('没有找到已保存的合约');
    return record;
  }
  contractInfo(id){const record=this.contractRecord(id);return {...record};}
  async importContract(address,name,abi){return this.exclusive(async()=>{
    if(!isAddress(address)||/^0x0{40}$/i.test(address))throw Error('合约地址格式不正确');
    const normalized=getAddress(address),code=await this.providers[0].getCode(normalized);if(code==='0x')throw Error('该地址没有合约代码');
    if(!Array.isArray(abi)||!abi.length||Buffer.byteLength(JSON.stringify(abi))>65536)throw Error('ABI必须是有效且不超过64KB的JSON数组');
    try{new Interface(abi);}catch{throw Error('ABI格式无效');}
    this.meta.developerContracts||=[];
    let record=this.meta.developerContracts.find(item=>item.address.toLowerCase()===normalized.toLowerCase());
    if(record){record.abi=abi;record.name=String(name||record.name).trim().slice(0,80)||record.name;}
    else{
      if(this.meta.developerContracts.length>=20)throw Error('最多保存20个合约');
      record={id:randomUUID(),name:String(name||'导入的合约').trim().slice(0,80)||'导入的合约',contractName:'Imported',address:normalized,abi,createdAt:new Date().toISOString(),imported:true};
      this.meta.developerContracts.unshift(record);
    }
    save(this.metaFile,this.meta);return {id:record.id,address:record.address,name:record.name};
  });}
  async readContract(id,signature,args){
    const record=this.contractRecord(id),fragment=new Interface(record.abi).getFunction(signature);
    if(!fragment||!['view','pure'].includes(fragment.stateMutability))throw Error('请选择只读函数');
    const contract=new Contract(record.address,record.abi,this.providers[0]);
    return {result:this.contractResult(await contract.getFunction(signature)(...this.contractArgs(args)))};
  }
  async writeContract(id,signature,args,from,value){return this.exclusive(async()=>{
    const record=this.contractRecord(id),fragment=new Interface(record.abi).getFunction(signature);
    if(!fragment||['view','pure'].includes(fragment.stateMutability))throw Error('请选择写入函数');
    const signer=this.signer(from),amount=this.contractValue(value);if(amount>0n&&fragment.stateMutability!=='payable')throw Error('这个函数不能接收NIU');
    await this.requireMining();const contract=new Contract(record.address,record.abi,signer),fn=contract.getFunction(signature),callArgs=this.contractArgs(args);
    const overrides={value:amount,gasPrice:2000000000n,type:0};const gas=await fn.estimateGas(...callArgs,overrides);
    const tx=await fn(...callArgs,{...overrides,gasLimit:gas+gas/5n});const receipt=await this.confirmed(tx,`调用合约 ${record.name}`);
    return {hash:tx.hash,block:receipt.blockNumber};
  });}
  tokenOptions(value){
    if(!value||typeof value!=='object')throw Error('代币参数无效');
    const name=String(value.name||'').trim(),symbol=String(value.symbol||'').trim().toUpperCase();
    const decimalsText=String(value.decimals??'').trim(),decimals=Number(decimalsText),mode=String(value.mode||'');
    const supply=String(value.supply||'').trim(),cap=String(value.cap||'').trim();
    if(!name||name.length>40||/[\u0000-\u001f]/.test(name))throw Error('代币名称需要1至40个字符');
    if(!/^[A-Z][A-Z0-9]{1,10}$/.test(symbol))throw Error('代币符号需要2至11位大写字母或数字');
    if(!/^\d+$/.test(decimalsText)||!Number.isInteger(decimals)||decimals<0||decimals>18)throw Error('小数位必须是0至18的整数');
    if(mode!=='fixed'&&mode!=='managed')throw Error('代币发行模式无效');
    let initialUnits;try{initialUnits=parseUnits(supply,decimals);}catch{throw Error('初始发行量格式与小数位不匹配');}
    if(initialUnits<=0n)throw Error('初始发行量必须大于0');
    let capUnits=initialUnits;
    if(mode==='managed'){
      try{capUnits=parseUnits(cap,decimals);}catch{throw Error('最大发行量格式与小数位不匹配');}
      if(capUnits<initialUnits)throw Error('最大发行量不能小于初始发行量');
    }
    if(initialUnits>UINT256_MAX||capUnits>UINT256_MAX)throw Error('发行量超过ERC-20可表示的最大值');
    return {name,symbol,decimals,mode,supply,cap:mode==='managed'?cap:supply,initialUnits,capUnits};
  }
  async prepareToken(options,from){return this.exclusive(async()=>{
    const token=this.tokenOptions(options),signer=this.signer(from),compiled=this.contractStudio.compileTemplate(token.mode);
    const contractName=token.mode==='managed'?'NiuManagedToken':'NiuFixedToken';
    const args=token.mode==='managed'?[token.name,token.symbol,token.decimals,signer.address,token.initialUnits,token.capUnits]:[token.name,token.symbol,token.decimals,signer.address,token.initialUnits];
    const estimate=await this.deploymentEstimate(compiled.buildId,contractName,args,signer.address,'0');
    while(this.tokenDrafts.size>=10)this.tokenDrafts.delete(this.tokenDrafts.keys().next().value);
    const draftId=randomUUID();this.tokenDrafts.set(draftId,{createdAt:Date.now(),token,from:signer.address,buildId:compiled.buildId,contractName,args,sourceHash:compiled.sourceHash,abi:compiled.artifacts[0].abi});
    return {draftId,...estimate,name:token.name,symbol:token.symbol,decimals:token.decimals,mode:token.mode,supply:token.supply,cap:token.cap,sourceHash:compiled.sourceHash};
  });}
  async issueToken(draftId){return this.exclusive(async()=>{
    const draft=this.tokenDrafts.get(draftId);if(!draft||Date.now()-draft.createdAt>20*60*1000)throw Error('代币预览已过期，请重新生成');
    const {artifact}=this.contractStudio.artifact(draft.buildId,draft.contractName),signer=this.signer(draft.from);await this.requireMining();
    this.meta.tokens||=[];this.meta.developerContracts||=[];
    if(this.meta.tokens.length>=20)throw Error('最多保存20种代币');
    if(this.meta.developerContracts.length>=20)throw Error('合约记录已达到20个上限');
    const factory=new ContractFactory(artifact.abi,artifact.bytecode,signer),request=await factory.getDeployTransaction(...draft.args,{gasPrice:2000000000n,type:0});
    const estimate=await signer.estimateGas(request),contract=await factory.deploy(...draft.args,{gasPrice:2000000000n,gasLimit:estimate+estimate/5n,type:0});
    const tx=contract.deploymentTransaction(),address=await contract.getAddress();
    const token={id:randomUUID(),address,name:draft.token.name,symbol:draft.token.symbol,decimals:draft.token.decimals,mode:draft.token.mode,
      supply:draft.token.supply,cap:draft.token.cap,owner:signer.address,deployHash:tx.hash,sourceHash:draft.sourceHash,createdAt:new Date().toISOString(),pending:true};
    const contractRecord={id:randomUUID(),name:`${token.name} (${token.symbol})`,contractName:draft.contractName,address,abi:draft.abi,sourceHash:draft.sourceHash,deployHash:tx.hash,createdAt:token.createdAt,pending:true};
    this.meta.tokens.unshift(token);this.meta.developerContracts.unshift(contractRecord);save(this.metaFile,this.meta);
    try{const receipt=await this.confirmed(tx,`发行代币 ${token.symbol}`);token.pending=false;token.block=receipt.blockNumber;contractRecord.pending=false;contractRecord.block=receipt.blockNumber;save(this.metaFile,this.meta);this.tokenDrafts.delete(draftId);return {address,hash:tx.hash,block:receipt.blockNumber,token};}
    catch(e){token.pending=false;token.failed=true;contractRecord.pending=false;contractRecord.failed=true;save(this.metaFile,this.meta);throw e;}
  });}
  async tokenMetadata(address){
    if(!isAddress(address)||/^0x0{40}$/i.test(address))throw Error('代币合约地址格式不正确');
    const normalized=getAddress(address);if(await this.providers[0].getCode(normalized)==='0x')throw Error('该地址没有合约代码');
    const contract=new Contract(normalized,ERC20_ABI,this.providers[0]);
    let name,symbol,decimals,totalSupply;try{[name,symbol,decimals,totalSupply]=await Promise.all([contract.name(),contract.symbol(),contract.decimals(),contract.totalSupply()]);}catch{throw Error('该合约不符合可识别的ERC-20接口');}
    name=String(name).slice(0,80);symbol=String(symbol).slice(0,20);decimals=Number(decimals);
    if(!name||!symbol||!Number.isInteger(decimals)||decimals<0||decimals>36)throw Error('代币元数据无效');
    return {address:normalized,name,symbol,decimals,totalSupply:String(totalSupply)};
  }
  async displayTokenMetadata(address){
    const normalized=getAddress(address),key=normalized.toLowerCase(),now=Date.now();
    this.tokenMetadataCache||=new Map();
    const cached=this.tokenMetadataCache.get(key);if(cached&&now-cached.at<TOKEN_METADATA_TTL_MS)return cached.value;
    const saved=(this.meta?.tokens||[]).find(item=>String(item.address).toLowerCase()===key);
    let value=null;
    try{
      const live=await this.tokenMetadata(normalized);
      value={name:live.name,symbol:live.symbol,decimals:live.decimals,recognized:true};
    }catch{
      const decimals=Number(saved?.decimals);
      if(saved&&saved.symbol&&Number.isInteger(decimals)&&decimals>=0&&decimals<=36)value={name:String(saved.name||'').slice(0,80),symbol:String(saved.symbol).slice(0,20),decimals,recognized:true};
      else value={name:'',symbol:'ERC-20',decimals:null,recognized:false};
    }
    this.tokenMetadataCache.set(key,{at:now,value});return value;
  }
  async erc20Transfers(tx,receipt){
    if(!tx)return [];
    const input=decodeErc20TransferInput(tx.data||'0x',tx.from,tx.to);
    const transfers=[];
    if(receipt?.status!==0)for(const log of (receipt?.logs||[])){
      try{
        const parsed=ERC20_TRANSFER_INTERFACE.parseLog({topics:log.topics,data:log.data});
        if(!parsed||parsed.name!=='Transfer')continue;
        transfers.push({contract:getAddress(log.address),from:getAddress(parsed.args[0]),to:getAddress(parsed.args[1]),rawAmount:String(parsed.args[2]),method:null,source:'event'});
      }catch{}
    }
    if(!transfers.length&&input)transfers.push(input);
    else if(input){
      const matched=transfers.find(item=>item.contract.toLowerCase()===input.contract.toLowerCase()&&item.to.toLowerCase()===input.to.toLowerCase());
      if(matched)matched.method=input.method;
    }
    const metadata=new Map();
    for(const item of transfers){
      const key=item.contract.toLowerCase();
      if(!metadata.has(key))metadata.set(key,await this.displayTokenMetadata(item.contract));
      const info=metadata.get(key);let amount=item.rawAmount;
      if(info.decimals!==null)try{amount=formatUnits(item.rawAmount,info.decimals);}catch{}
      Object.assign(item,info,{amount});
    }
    return transfers;
  }
  attachTokenTransfers(item,transfers){
    if(!transfers?.length)return false;
    item.assetType='erc20';item.tokenTransfers=transfers;
    const mine=new Set((this.walletAddresses||[]).map(address=>address.toLowerCase()));
    const incoming=transfers.find(entry=>mine.has(entry.to.toLowerCase()));
    const outgoing=transfers.find(entry=>mine.has(entry.from.toLowerCase()));
    const primary=(outgoing&&String(item.from||'').toLowerCase()===outgoing.from.toLowerCase())?outgoing:(incoming||outgoing||transfers[0]);
    if(incoming&&!outgoing)item.dir='in';else if(outgoing)item.dir='out';
    item.counterparty=item.dir==='in'?primary.from:primary.to;
    item.kind=item.dir==='in'?`收到代币 ${primary.symbol}`:`发送代币 ${primary.symbol}`;
    return true;
  }
  async importToken(address){return this.exclusive(async()=>{
    this.meta.tokens||=[];
    const info=await this.tokenMetadata(address);let token=this.meta.tokens.find(item=>item.address.toLowerCase()===info.address.toLowerCase());
    if(token)Object.assign(token,info,{imported:token.imported||!token.deployHash});
    else{if(this.meta.tokens.length>=20)throw Error('最多保存20种代币');token={id:randomUUID(),...info,imported:true,createdAt:new Date().toISOString()};this.meta.tokens.unshift(token);}
    save(this.metaFile,this.meta);return token;
  });}
  async tokenPortfolio(){
    const result=[];
    for(const saved of (this.meta.tokens||[])){
      try{
        const info=await this.tokenMetadata(saved.address),contract=new Contract(info.address,ERC20_ABI,this.providers[0]);
        const raw=await Promise.all(this.walletAddresses.map(address=>contract.balanceOf(address)));
        const walletTotalRaw=raw.reduce((sum,item)=>sum+item,0n);
        result.push({...saved,...info,totalSupplyFormatted:formatUnits(info.totalSupply,info.decimals),walletTotalRaw:String(walletTotalRaw),walletTotalFormatted:formatUnits(walletTotalRaw,info.decimals),balances:this.walletAddresses.map((address,index)=>({address,raw:String(raw[index]),formatted:formatUnits(raw[index],info.decimals)}))});
      }catch(e){result.push({...saved,error:e.shortMessage||e.message});}
    }
    return {tokens:result};
  }
  async transferToken(address,from,to,amount){return this.exclusive(async()=>{
    const token=(this.meta.tokens||[]).find(item=>item.address.toLowerCase()===String(address).toLowerCase());if(!token)throw Error('请先导入这个代币');
    if(!isAddress(to)||/^0x0{40}$/i.test(to))throw Error('代币收款地址格式不正确');
    let units;try{units=parseUnits(String(amount),Number(token.decimals));}catch{throw Error('代币数量格式不正确');}if(units<=0n)throw Error('代币数量必须大于0');
    if(units>UINT256_MAX)throw Error('代币数量超过ERC-20可表示的最大值');
    const signer=this.signer(from);await this.requireMining();const contract=new Contract(token.address,ERC20_ABI,signer);
    if(await contract.balanceOf(signer.address)<units)throw Error('代币余额不足');
    const gas=await contract.transfer.estimateGas(getAddress(to),units,{gasPrice:2000000000n,type:0});
    const tx=await contract.transfer(getAddress(to),units,{gasPrice:2000000000n,gasLimit:gas+gas/5n,type:0});const receipt=await this.confirmed(tx,`发送代币 ${token.symbol}`);
    return {hash:tx.hash,block:receipt.blockNumber};
  });}
  async newAddress(label){return this.exclusive(async()=>{
    if(typeof label!=='string'||label.trim().length>40)throw Error('地址备注最多40个字符');
    const unlocked=this.requireUnlocked();
    if(unlocked.length>=32)throw Error('本版最多保存32个本地地址');
    const wallet=Wallet.createRandom(),wallets=[...unlocked,wallet];
    const secret=Buffer.from(JSON.stringify({version:1,keys:wallets.map(w=>w.privateKey)}));
    try{writeFileSync(this.walletFile+'.new',crypt('protect',secret).toString('base64'),{flag:'wx'});renameSync(this.walletFile+'.new',this.walletFile);}
    finally{secret.fill(0);}
    // Keys reach disk first. A failed label update must not lose the new key.
    this.wallets=wallets;this.walletAddresses=wallets.map(w=>w.address);this.meta.receiveLabels||={};this.meta.receiveLabels[wallet.address]=label.trim()||`收款地址${wallets.length}`;
    this.checkHash=createHash('sha256').update(`${LOCK_SALT}:${this.walletAddresses.join(',')}`).digest('hex');
    this.meta.activeReceivingAddress=wallet.address;this.meta.backupRequired=true;save(this.metaFile,this.meta);
    return {address:wallet.address,backupRequired:true};
  });}
  async saveContact(address,label){return this.exclusive(async()=>{
    if(!isAddress(address)||/^0x0{40}$/i.test(address))throw Error('联系人地址无效');
    if(typeof label!=='string'||!label.trim()||label.trim().length>40)throw Error('联系人备注需要1至40个字符');
    const normalized=getAddress(address);this.meta.contacts||=[];
    const existing=this.meta.contacts.find(c=>c.address===normalized);
    if(existing)existing.label=label.trim();
    else{if(this.meta.contacts.length>=100)throw Error('地址簿最多保存100个联系人');this.meta.contacts.push({address:normalized,label:label.trim()});}
    save(this.metaFile,this.meta);return {saved:true,address:normalized};
  });}
  async portableBackup(password){return this.exclusive(async()=>{
    const unlocked=this.requireUnlocked();
    const backup=await exportPortable(unlocked,password,{chainId:this.network?.chainId||CHAIN_ID,genesisHash:this.genesisHash});
    const dir=resolve(this.base,'backups');mkdirSync(dir,{recursive:true});
    const file=resolve(dir,`niu-wallet-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    writeFileSync(file,JSON.stringify(backup,null,2),{flag:'wx'});
    // Read back and decrypt before reporting a usable backup.
    const restored=await importPortable(readFileSync(file,'utf8'),password,backup.network);
    if(restored.some((w,i)=>w.address!==this.walletAddresses[i]))throw Error('备份回读校验失败');
    this.meta.backupRequired=false;this.meta.backedUpAddresses=[...this.walletAddresses];save(this.metaFile,this.meta);
    return {path:file,scope:'可跨电脑恢复；必须同时保管备份文件和密码'};
  });}
  // Import keys into the CURRENT wallet. Accepts either a portable encrypted
  // backup (password protected, works across machines) or a same-machine vault
  // file (wallet.dpapi / .dat, bound to this Windows account). Duplicate
  // addresses are skipped; the merged vault is written atomically.
  async importWalletFile(filePath,password){
    if(typeof filePath!=='string'||!filePath||statSync(filePath).size>131072)throw Error('钱包文件无效或过大');
    const text=readFileSync(filePath,'utf8').trim();
    return this.importWalletText(text,password);
  }
  async importWalletText(text,password){return this.exclusive(async()=>{
    if(typeof text!=='string'||!text.trim()||Buffer.byteLength(text)>131072)throw Error('钱包文件无效或过大');
    text=text.trim();
    let keys;
    if(text.startsWith('{')){
      const restored=await importPortable(text,password,{chainId:this.network?.chainId||CHAIN_ID,genesisHash:this.genesisHash});
      keys=restored.map(w=>w.privateKey);
    }else{
      const decrypted=crypt('unprotect',Buffer.from(text,'base64'));
      try{
        const vault=JSON.parse(decrypted.toString());
        if(vault.version!==1||!Array.isArray(vault.keys)||!vault.keys.length)throw Error('钱包文件格式不兼容');
        keys=vault.keys;
      }finally{decrypted.fill(0);}
    }
    const merged=[...this.requireUnlocked()];let added=0;
    for(const key of keys){
      const wallet=new Wallet(key);
      if(merged.some(x=>x.address.toLowerCase()===wallet.address.toLowerCase()))continue;
      if(merged.length>=32)throw Error('本版最多保存32个本地地址');
      merged.push(wallet);added++;
    }
    if(added){
      const secret=Buffer.from(JSON.stringify({version:1,keys:merged.map(w=>w.privateKey)}));
      try{writeFileSync(this.walletFile+'.new',crypt('protect',secret).toString('base64'),{flag:'wx'});renameSync(this.walletFile+'.new',this.walletFile);}
      finally{secret.fill(0);}
      this.wallets=merged;this.walletAddresses=merged.map(w=>w.address);
      this.checkHash=createHash('sha256').update(`${LOCK_SALT}:${this.walletAddresses.join(',')}`).digest('hex');
      this.meta.backupRequired=true;save(this.metaFile,this.meta);
    }
    return {added,total:merged.length,addresses:merged.map(w=>w.address)};
  });}
  async transactionDetails(hash){
    if(typeof hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(hash))throw Error('交易哈希格式不正确');
    const saved=this.meta.transactions.find(item=>item.hash.toLowerCase()===hash.toLowerCase());
    if(!saved)throw Error('钱包交易记录中没有这笔交易');
    const p=this.providers[0];
    const [tx,receipt,height]=await Promise.all([
      p.getTransaction(hash).catch(()=>null),p.getTransactionReceipt(hash).catch(()=>null),p.getBlockNumber()
    ]);
    if(!tx&&!receipt)throw Error('节点暂时查不到这笔交易，请等待同步完成');
    const blockNumber=receipt?.blockNumber??tx?.blockNumber??saved.block??null;
    let block=null;
    if(blockNumber!==null)try{block=await p.getBlock(blockNumber);}catch{}
    const gasPrice=receipt?.gasPrice??tx?.gasPrice??0n;
    const gasUsed=receipt?.gasUsed??0n;
    const input=tx?.data||'0x';
    const tokenTransfers=await this.erc20Transfers(tx,receipt);
    return {
      hash:tx?.hash||saved.hash,
      status:receipt?(receipt.status===1?'confirmed':'failed'):(saved.status||'pending'),
      confirmations:blockNumber===null?0:Math.max(0,height-Number(blockNumber)+1),
      blockNumber,blockHash:receipt?.blockHash||tx?.blockHash||saved.blockHash||null,
      transactionIndex:receipt?.index??tx?.index??null,
      timestamp:block?new Date(block.timestamp*1000).toISOString():saved.at||null,
      from:tx?.from||saved.from||null,to:tx?.to||saved.to||null,
      amount:tx?formatEther(tx.value):saved.amount,
      nonce:tx?.nonce??null,type:tx?.type??null,chainId:Number(tx?.chainId??this.network?.chainId??CHAIN_ID),
      gasLimit:tx?String(tx.gasLimit):null,gasUsed:receipt?String(gasUsed):null,
      gasPriceWei:gasPrice?String(gasPrice):null,gasPriceGwei:gasPrice?formatUnits(gasPrice,'gwei'):null,
      fee:receipt&&gasPrice?formatEther(gasUsed*gasPrice):null,
      input,inputBytes:input==='0x'?0:(input.length-2)/2,
      contractAddress:receipt?.contractAddress||null,logsCount:receipt?.logs?.length??null,
      assetType:tokenTransfers.length?'erc20':'native',tokenTransfers
    };
  }
  async state(){
    if(!this.ready)throw Error('节点未就绪或已退出，请查看节点日志');
    const p=this.providers[0];
    const [heights,balances,mining,peers,syncing,nodeInfo]=await Promise.all([
      Promise.all(this.providers.map(x=>x.getBlockNumber())),Promise.all(this.walletAddresses.map(a=>p.getBalance(a))),
      p.send('eth_mining',[]),p.send('net_peerCount',[]),p.send('eth_syncing',[]),p.send('admin_nodeInfo',[])]);
    const blocks=[];
    for(let n=heights[0];n>=Math.max(0,heights[0]-5);n--){const b=await p.getBlock(n);blocks.push({number:n,hash:b.hash,transactions:b.transactions.length,timestamp:b.timestamp});}
    // Ledger scan: walk new blocks and record every transaction that touches one
    // of this wallet's addresses, so incoming payments show up with sender and
    // amount instead of only the transfers this machine sent itself.
    let changed=false;
    if(this.meta.lastBlock!==heights[0]){this.meta.lastBlock=heights[0];changed=true;}
    if(!this.lastLedgerScan||Date.now()-this.lastLedgerScan>5000){
      this.lastLedgerScan=Date.now();
      const scannedTo=typeof this.meta.scannedTo==='number'?this.meta.scannedTo:0;
      const known=new Set(this.meta.transactions.map(x=>x.hash));
      const mine=this.walletAddresses.map(a=>a.toLowerCase());
      for(let n=Math.max(1,scannedTo+1);n<=heights[0];n++){
        let b;try{b=await p.getBlock(n,true);}catch{break;}
        for(const t of b.prefetchedTransactions){
          const to=(t.to||'').toLowerCase(),sender=(t.from||'').toLowerCase();
          const tokenTransfers=await this.erc20Transfers(t,null);
          const tokenIncoming=tokenTransfers.some(entry=>mine.includes(entry.to.toLowerCase()));
          const tokenOutgoing=tokenTransfers.some(entry=>mine.includes(entry.from.toLowerCase()));
          const incoming=mine.includes(to)||tokenIncoming,outgoing=mine.includes(sender)||tokenOutgoing;
          if((!incoming&&!outgoing)||known.has(t.hash))continue;
          const item={hash:t.hash,dir:tokenIncoming&&!tokenOutgoing?'in':(incoming&&!outgoing?'in':'out'),kind:incoming?'收款':'转出',
            from:t.from,to:t.to||'',amount:formatEther(t.value??0n),block:n,blockHash:b.hash,
            status:'confirmed',confirmations:Math.max(0,heights[0]-n+1),at:new Date(b.timestamp*1000).toISOString(),
            call:!!t.data&&t.data!=='0x'};
          if(tokenTransfers.length){this.attachTokenTransfers(item,tokenTransfers);item.assetChecked=true;}
          this.meta.transactions.unshift(item);
          known.add(t.hash);changed=true;
        }
        this.meta.scannedTo=n;
      }
      if(this.meta.scannedTo!==scannedTo)changed=true;
      if(this.meta.transactions.length>TRANSACTION_LIMIT)this.meta.transactions=this.meta.transactions.slice(0,TRANSACTION_LIMIT);
    }
    for(const item of this.meta.transactions){
      const r=await p.getTransactionReceipt(item.hash);
      if(r){
        const next=r.status===1?'confirmed':'failed',confirmations=Math.max(0,heights[0]-r.blockNumber+1);
        if(item.status!==next||item.blockHash!==r.blockHash||item.confirmations!==confirmations){
          item.status=next;item.block=r.blockNumber;item.blockHash=r.blockHash;item.confirmations=confirmations;changed=true;
        }
        if(!item.assetChecked&&(item.call||/代币/.test(item.kind||''))){
          const tx=await p.getTransaction(item.hash).catch(()=>null),transfers=await this.erc20Transfers(tx,r);
          this.attachTokenTransfers(item,transfers);item.assetChecked=true;changed=true;
        }
      }else if(item.block!==undefined){
        item.status='reorged';delete item.block;delete item.blockHash;item.confirmations=0;changed=true;
      }
    }
    if(changed)save(this.metaFile,this.meta);
    let contract=null;
    if(this.meta.contract){
      const address=this.meta.contract.address,code=await p.getCode(address);
      if(code!=='0x'){
        const c=new Contract(address,this.artifact().abi,p);
        contract={address,message:await c.message(),updates:String(await c.updates()),owner:await c.owner()};
      }else{
        const r=await p.getTransactionReceipt(this.meta.contract.deployHash);
        if(r?.status===0){this.meta.contract=null;save(this.metaFile,this.meta);}else contract={address,pending:true};
      }
    }
    return {name:this.network?'牛链网络':'牛链',chainId:this.network?.chainId||CHAIN_ID,genesisHash:this.genesisHash,heights,peers:Number(peers),
      syncing:syncPending(syncing)?syncing:false,connectionStatus:Number(peers)===0?'disconnected':syncPending(syncing)?'syncing':'connected',enode:nodeInfo.enode,
      chainRecovered:this.chainRecovered||null,chainReset:this.chainReset||null,
      mining,miningUntil:this.miningUntil,busy:this.busy,locked:this.locked,
      wallets:this.walletAddresses.map((a,i)=>({address:a,balance:formatEther(balances[i]),name:this.meta.receiveLabels?.[a]||(i===0?'默认挖矿地址':`收款地址${i+1}`)})),
      walletTotal:formatEther(balances.reduce((sum,balance)=>sum+balance,0n)),contacts:this.meta.contacts||[],backupRequired:this.walletAddresses.some(a=>!(this.meta.backedUpAddresses||[]).includes(a)),activeReceivingAddress:this.meta.activeReceivingAddress||this.walletAddresses[0],
      blocks,transactions:this.meta.transactions,contract,
      tokens:(this.meta.tokens||[]).map(({id,address,name,symbol,decimals,mode,pending,failed})=>({id,address,name,symbol,decimals,mode,pending,failed})),
      developerContracts:(this.meta.developerContracts||[]).map(({id,name,contractName,address,pending,failed,imported})=>({id,name,contractName,address,pending,failed,imported})),
      walletProtection:walletProtection(),dataPath:this.base};
  }
  async close(){
    this.stopping=true;this.ready=false;clearTimeout(this.timer);
    if(this.providers[0])try{await this.providers[0].send('miner_stop',[]);}catch{}
    const exited=await Promise.all(this.children.map(c=>new Promise(resolve=>{
      if(c.exitCode!==null)return resolve(true);
      const timer=setTimeout(()=>resolve(false),SHUTDOWN_GRACE_MS);
      c.once('exit',()=>{clearTimeout(timer);resolve(true);});
      // "exit" quits geth's console, which runs its orderly Stop() and flushes state.
      try{c.stdin.on('error',()=>{});c.stdin.write('exit\n');}catch{resolve(false);}
    })));
    this.graceful=exited.every(Boolean);
    // A forced kill can leave the chain DB without its head state. Report which
    // nodes needed it so callers can tell the user to expect a re-sync instead of
    // silently presenting a possibly damaged database as a normal shutdown.
    this.killedUncleanly=this.children.map((c,i)=>!exited[i]);
    this.children.forEach((c,i)=>{if(!exited[i])c.kill();});
    for(const p of this.providers)p.destroy();
    this.logs.forEach(l=>l.end());this.lock();this.wallets=[];
    if(this.ownsLock){try{unlinkSync(this.lockFile);}catch{}this.ownsLock=false;}
    return this.graceful;
  }
}
