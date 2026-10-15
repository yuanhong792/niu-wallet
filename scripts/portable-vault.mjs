// SPDX-License-Identifier: GPL-3.0-or-later
import {Wallet, encryptKeystoreJson, decryptKeystoreJson, getAddress} from 'ethers';

function passwordCheck(password) {
  if(typeof password!=='string'||password.length<12||Buffer.byteLength(password)>1024)
    throw Error('备份密码至少12个字符，最多1024字节；请单独妥善保存。');
}
function networkCheck(network) {
  if(!Number.isSafeInteger(network?.chainId)||network.chainId<=0||!/^0x[0-9a-f]{64}$/i.test(network.genesisHash||''))
    throw Error('备份网络标识无效');
}
export async function exportPortable(wallets,password,network) {
  passwordCheck(password); networkCheck(network);
  if(!Array.isArray(wallets)||wallets.length<2||wallets.length>32)throw Error('钱包数量不匹配');
  const accounts=[];
  for(const wallet of wallets) accounts.push(JSON.parse(await encryptKeystoreJson(
    {address:wallet.address,privateKey:wallet.privateKey},password,{scrypt:{N:131072,r:8,p:1}})));
  return {format:'niu-portable-wallet',version:1,network,accounts};
}
export async function importPortable(text,password,network) {
  passwordCheck(password);networkCheck(network);
  if(typeof text!=='string'||Buffer.byteLength(text)>131072)throw Error('备份文件过大');
  let backup;try{backup=JSON.parse(text);}catch{throw Error('备份文件不是有效JSON');}
  if(backup.format!=='niu-portable-wallet'||backup.version!==1||!Array.isArray(backup.accounts)||backup.accounts.length<2||backup.accounts.length>32)
    throw Error('备份格式不兼容');
  if(backup.network?.chainId!==network.chainId||backup.network?.genesisHash?.toLowerCase()!==network.genesisHash.toLowerCase())
    throw Error('备份属于另一条网络，请勿混用');
  const wallets=[];
  for(const account of backup.accounts) {
    const c=account?.Crypto||account?.crypto,k=c?.kdfparams;
    // Bound untrusted KDF parameters before invoking the keystore decoder.
    if(account.version!==3||c?.cipher!=='aes-128-ctr'||c?.kdf!=='scrypt'||k?.n!==131072||k?.r!==8||k?.p!==1||k?.dklen!==32||
      !/^[0-9a-f]{64}$/i.test(k?.salt||'')||!/^[0-9a-f]{32}$/i.test(c?.cipherparams?.iv||'')||
      !/^[0-9a-f]{64}$/i.test(c?.ciphertext||'')||!/^[0-9a-f]{64}$/i.test(c?.mac||'')||!/^[0-9a-f]{40}$/i.test(account.address||''))
      throw Error('备份加密参数或字段不兼容');
    let decoded;try{decoded=await decryptKeystoreJson(JSON.stringify(account),password);}catch{throw Error('密码不正确或备份已损坏');}
    const wallet=new Wallet(decoded.privateKey);
    if(wallet.address!==getAddress('0x'+account.address))throw Error('备份地址校验失败');
    wallets.push(wallet);
  }
  if(new Set(wallets.map(w=>w.address)).size!==wallets.length)throw Error('备份中的账户重复');
  return wallets;
}
