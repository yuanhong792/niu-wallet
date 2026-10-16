// Real PoW integration on loopback, with independent data directories and keys.
// This is not proof of connectivity between two physical computers.
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Wallet,Contract,parseEther} from 'ethers';
import {NiuLab,ROOT,waitFor} from './lab.mjs';
import {validateNetwork,syncPending} from './network.mjs';
import {importPortable} from './portable-vault.mjs';
const run=resolve(ROOT,'runtime','network-qa-'+Date.now());mkdirSync(run,{recursive:true});
const profile={version:1,chainId:26261017,networkId:26261017,genesisHash:'0x9590d27e9e5977eb00bf1fd794d93fce0cac22dad04dc3f25fc072ab0c87e053',
  peers:[],allowPeerIPs:[],listenAddress:'127.0.0.1',advertiseIP:null,coordinator:true,restrictPeerIPs:true};
const a=new NiuLab({base:resolve(run,'a'),ports:[19345],p2p:[30971],auth:[19351],network:validateNetwork(profile)});
let b;const report={status:'running',scope:'independent processes and keys on one physical computer; loopback only',checks:{}};
const check=(name,ok)=>{if(!ok)throw Error(name);report.checks[name]=true;};
try{
  await a.start();const nodeA=await a.providers[0].send('admin_nodeInfo',[]),enodeA=nodeA.enode.replace(/@[^:]+:/,'@127.0.0.1:');
  b=new NiuLab({base:resolve(run,'b'),ports:[19346],p2p:[30972],auth:[19352],network:validateNetwork({...profile,coordinator:false,peers:[enodeA]})});
  await b.start();const pa=a.providers[0],pb=b.providers[0],nodeB=await pb.send('admin_nodeInfo',[]);
  check('separateWalletKeys',a.wallets[0].address!==b.wallets[0].address);
  check('separateNodeIdentities',nodeA.id!==nodeB.id);
  check('sameGenesis',a.genesisHash===profile.genesisHash&&b.genesisHash===a.genesisHash);
  for(const method of ['admin_nodeInfo','miner_start']){
    const response=await fetch('http://127.0.0.1:19345',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:[]})});
    const body=await response.json();check('httpRejects_'+method,!!body.error);
  }
  check('zeroGenesisAllocation',await pa.getBalance(a.wallets[0].address,0)===0n);
  await waitFor('节点互联',async()=>Number(await pb.send('net_peerCount',[]))>0,60000);
  await waitFor('同步启动完成',async()=>!syncPending(await pa.send('eth_syncing',[]))&&!syncPending(await pb.send('eth_syncing',[])),60000);
  await a.mine(true);await waitFor('真实挖矿两块',async()=>await pa.getBlockNumber()>=2,240000);await a.mine(false);
  const height=await pa.getBlockNumber();
  check('1000NIUSubsidyPerBlock',await pa.getBalance(a.wallets[0].address,height)===BigInt(height)*parseEther('1000'));
  await waitFor('另一节点同步区块',async()=>await pb.getBlockNumber()>=height,120000);
  check('blockHashAgreement',(await pa.getBlock(height)).hash===(await pb.getBlock(height)).hash);
  const newAddress=(await a.newAddress('备用收款地址')).address;
  check('newAddressSaved',a.wallets.length===3&&a.wallets[2].address===newAddress);
  await a.saveContact(b.wallets[0].address,'朋友的钱包');check('contactAddressBook',a.meta.contacts[0].address===b.wallets[0].address);
  const password='Integration-QA-'+Wallet.createRandom().address,backup=await a.portableBackup(password);
  const restored=await importPortable(readFileSync(backup.path,'utf8'),password,{chainId:profile.chainId,genesisHash:a.genesisHash});
  check('backupContainsNewAddress',restored.length===3&&restored[2].address===newAddress);
  await a.mine(true);
  const outgoing=await a.transfer(b.wallets[0].address,'0.1');
  await waitFor('收款节点同步转账',()=>pb.getTransactionReceipt(outgoing.hash),120000);
  check('crossNodeTransfer',await pb.getBalance(b.wallets[0].address)===parseEther('0.1'));
  const incoming=await b.transfer(newAddress,'0.01',b.wallets[0].address);
  await waitFor('新地址收到回转交易',()=>pa.getTransactionReceipt(incoming.hash),120000);
  check('remoteMinerAcceptsOtherWalletTransaction',await pa.getBalance(newAddress)===parseEther('0.01'));
  const spendNewAddress=await a.transfer(b.wallets[0].address,'0.001',newAddress);
  await waitFor('新地址签名转账传播',()=>pb.getTransactionReceipt(spendNewAddress.hash),120000);
  check('newReceiveAddressCanSpend',await pa.getBalance(newAddress)<parseEther('0.009'));
  const deployed=await a.deploy('NIU security regression');
  await waitFor('另一节点同步合约',async()=>await pb.getCode(deployed.address)!=='0x',120000);
  const contract=new Contract(deployed.address,a.artifact().abi,pb);
  check('solidityDeploymentAfterDependencyUpgrade',await contract.message()==='NIU security regression');
  await a.update('NIU dependency regression passed');
  await waitFor('另一节点同步合约更新',async()=>await contract.message()==='NIU dependency regression passed',120000);
  check('solidityUpdateAfterDependencyUpgrade',true);
  await a.mine(false);
  report.height=await pa.getBlockNumber();report.genesisHash=a.genesisHash;report.status='passed';
}catch(e){report.status='failed';report.error=e.shortMessage||e.message;process.exitCode=1;}
finally{
  if(b)await b.close();await a.close();report.gracefulShutdown=a.graceful&&(!b||b.graceful);
  report.finishedAt=new Date().toISOString();writeFileSync(resolve(run,'report.json'),JSON.stringify(report,null,2));
  mkdirSync(resolve(ROOT,'evidence'),{recursive:true});writeFileSync(resolve(ROOT,'evidence/network-integration.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
