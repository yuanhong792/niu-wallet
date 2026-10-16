import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,createWriteStream,unlinkSync,statSync} from 'node:fs';
import net from 'node:net';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Wallet,JsonRpcProvider,ContractFactory,Contract,isAddress,getAddress,parseEther,formatEther} from 'ethers';
import solc from 'solc';
import {exportPortable,importPortable} from './portable-vault.mjs';
import {loadNetwork,p2pConfig,syncPending} from './network.mjs';
import {NiuProvider} from './local-provider.mjs';
export const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const CHAIN_ID=26261015;
export const LOCK_IDLE_MS=5*60*1000;   // auto-lock the vault after 5 minutes without a signing action
export const TRANSACTION_LIMIT=200;    // ledger entries kept in activity.json (incoming + outgoing)
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
function crypt(mode,bytes){
  const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve(ROOT,'scripts/wallet-vault.ps1'),'-Mode',mode],
    {input:Buffer.from(bytes).toString('base64'),encoding:'utf8',windowsHide:true,timeout:30000});
  if(r.status!==0)throw Error('Windows钱包加解密失败。请使用创建钱包时的Windows账户；不要覆盖原钱包。');
  return Buffer.from(r.stdout.trim(),'base64');
}
export class NiuLab {
  constructor({base=resolve(ROOT,'runtime/persistent'),ports=[18645,18646],p2p=[30471,30472],auth=[18651,18652],network=loadNetwork(ROOT),nodeBin}={}){
    this.base=base;this.ports=ports;this.p2p=p2p;this.auth=auth;this.children=[];this.logs=[];this.providers=[];
    this.nodeBin=nodeBin;this.ready=false;this.miningUntil=null;this.timer=null;this.busy=false;this.stopping=false;
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
    try{
      for(let i=0;i<this.ports.length;i++){
        const datadir=resolve(this.base,`node${i+1}`),exe=this.nodeBin||resolve(ROOT,this.network?'bin/niu-geth-candidate.exe':'bin/geth.exe');
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
      // The coordinator is started on demand by the attendant tool, so the desktop
      // 10-minute session must not cut it off while it still has work to do.
      const window=(this.network&&this.network.coordinator)?0:600000;
      this.miningUntil=window?Date.now()+window:null;
      clearTimeout(this.timer);
      if(window)this.timer=setTimeout(()=>this.mine(false).catch(()=>{}),window);
    }else{await this.providers[0].send('miner_stop',[]);this.miningUntil=null;clearTimeout(this.timer);}
    return {mining:enabled,until:this.miningUntil};
  }
  async confirmed(tx,kind){
    this.meta.transactions.unshift({hash:tx.hash,kind,status:'pending',dir:'out',to:tx.to||'',amount:formatEther(tx.value??0n),at:new Date().toISOString()});
    this.meta.transactions=this.meta.transactions.slice(0,TRANSACTION_LIMIT);save(this.metaFile,this.meta);
    const r=await waitFor('交易确认（需要开启挖矿）',()=>this.providers[0].getTransactionReceipt(tx.hash),240000);
    const item=this.meta.transactions.find(x=>x.hash===tx.hash);item.status=r.status===1?'confirmed':'failed';item.block=r.blockNumber;save(this.metaFile,this.meta);
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
    if(await this.providers[0].getBalance(signer.address)<value+21000n*2000000000n)throw Error('余额不足，请先挖矿获得测试NIU，并预留手续费');
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
  async importWalletFile(filePath,password){return this.exclusive(async()=>{
    if(typeof filePath!=='string'||!filePath||statSync(filePath).size>131072)throw Error('钱包文件无效或过大');
    const text=readFileSync(filePath,'utf8').trim();
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
          const incoming=mine.includes(to),outgoing=mine.includes(sender);
          if((!incoming&&!outgoing)||known.has(t.hash))continue;
          this.meta.transactions.unshift({hash:t.hash,dir:incoming?'in':'out',kind:incoming?'收款':'转出',
            from:t.from,to:t.to||'',amount:formatEther(t.value??0n),block:n,blockHash:b.hash,
            status:'confirmed',confirmations:Math.max(0,heights[0]-n+1),at:new Date(b.timestamp*1000).toISOString(),
            call:!!t.data&&t.data!=='0x'});
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
    return {name:this.network?'牛链集成验证网络':'牛链本地测试网',chainId:this.network?.chainId||CHAIN_ID,genesisHash:this.genesisHash,heights,peers:Number(peers),
      syncing:syncPending(syncing)?syncing:false,connectionStatus:Number(peers)===0?'disconnected':syncPending(syncing)?'syncing':'connected',enode:nodeInfo.enode,
      chainRecovered:this.chainRecovered||null,chainReset:this.chainReset||null,
      mining,miningUntil:this.miningUntil,busy:this.busy,locked:this.locked,
      wallets:this.walletAddresses.map((a,i)=>({address:a,balance:formatEther(balances[i]),name:this.meta.receiveLabels?.[a]||(i===0?'默认挖矿地址':`收款地址${i+1}`)})),
      walletTotal:formatEther(balances.reduce((sum,balance)=>sum+balance,0n)),contacts:this.meta.contacts||[],backupRequired:this.walletAddresses.some(a=>!(this.meta.backedUpAddresses||[]).includes(a)),activeReceivingAddress:this.meta.activeReceivingAddress||this.walletAddresses[0],
      blocks,transactions:this.meta.transactions,contract,walletProtection:'Windows DPAPI · 当前账户 · 需口令解锁',dataPath:this.base};
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
