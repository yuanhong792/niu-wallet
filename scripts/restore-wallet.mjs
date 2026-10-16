// SPDX-License-Identifier: GPL-3.0-or-later
// Offline import into a NEW data directory only. Password is accepted via stdin,
// never process arguments, environment variables, logs, or a temporary file.
import {readFileSync,existsSync,mkdirSync,readdirSync,writeFileSync,unlinkSync,statSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {importPortable} from './portable-vault.mjs';
import {loadNetwork} from './network.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const data=resolve(root,'runtime/persistent');
let lock=false;
try{
  process.stdin.setEncoding('utf8');
  let input='';for await(const bytes of process.stdin){input+=bytes;if(Buffer.byteLength(input)>8192)throw Error('输入过长');}
  let request;try{request=JSON.parse(input);}catch{throw Error('恢复请求格式无效');}
  const {path,password}=request;
  if(typeof path!=='string'||!path||statSync(path).size>131072)throw Error('备份文件无效或过大');
  const profile=loadNetwork(root);
  const network=profile?{chainId:profile.chainId,genesisHash:profile.genesisHash}:
    {chainId:26261015,genesisHash:'0xe98bb84266b6171c8bc753e9c7c0f7adad3cc42909124726c737eef80d62f0df'};
  const wallets=await importPortable(readFileSync(path,'utf8'),password,network);
  mkdirSync(data,{recursive:true});
  writeFileSync(resolve(data,'lab.lock'),String(process.pid),{flag:'wx'});lock=true;
  if(readdirSync(data).some(name=>name!=='lab.lock'))throw Error('仅允许恢复到全新的钱包目录，不会覆盖原钱包或链数据');
  const secret=Buffer.from(JSON.stringify({version:1,keys:wallets.map(w=>w.privateKey)}));
  try{
    const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve(root,'scripts/wallet-vault.ps1'),'-Mode','protect'],
      {input:secret.toString('base64'),encoding:'utf8',windowsHide:true,timeout:30000});
    if(result.status!==0||!/^[A-Za-z0-9+/=]+$/.test(result.stdout.trim()))throw Error('本机钱包加密失败');
    writeFileSync(resolve(data,'wallet.dpapi'),result.stdout.trim(),{flag:'wx'});
  }finally{secret.fill(0);}
  console.log(JSON.stringify({restored:true,address:wallets[0].address,chainId:network.chainId}));
}catch(e){console.error('钱包恢复失败：'+(e.code==='EEXIST'?'目录已有钱包或正在使用':e.message));process.exitCode=1;}
finally{if(lock)unlinkSync(resolve(data,'lab.lock'));}
