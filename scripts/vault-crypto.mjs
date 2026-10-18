// SPDX-License-Identifier: GPL-3.0-or-later
import {spawnSync} from 'node:child_process';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const SERVICE='com.niulian.wallet.vault.v1';
const ACCOUNT=process.env.USER||process.env.LOGNAME||'local-user';
const MAGIC=Buffer.from('NIU1');

function command(program,args,input){
  return spawnSync(program,args,{input,encoding:'utf8',windowsHide:true,timeout:30000});
}

function macKey(){
  // Automated tests can inject an ephemeral key without touching Keychain.
  if(process.env.NIU_WALLET_VAULT_KEY){
    const key=Buffer.from(process.env.NIU_WALLET_VAULT_KEY,'hex');
    if(key.length!==32)throw Error('NIU_WALLET_VAULT_KEY 必须是32字节十六进制密钥');
    return key;
  }
  let result=command('/usr/bin/security',['find-generic-password','-a',ACCOUNT,'-s',SERVICE,'-w']);
  if(result.status===0){
    const key=Buffer.from(result.stdout.trim(),'hex');
    if(key.length!==32)throw Error('macOS钥匙串中的钱包主密钥格式无效');
    return key;
  }
  const key=randomBytes(32);
  result=command('/usr/bin/security',['add-generic-password','-U','-a',ACCOUNT,'-s',SERVICE,'-l','牛币钱包本机密钥','-w',key.toString('hex')]);
  if(result.status!==0)throw Error('无法写入macOS钥匙串，请允许牛币钱包访问钥匙串');
  return key;
}

function macCrypt(mode,bytes){
  const key=macKey();
  try{
    if(mode==='protect'){
      const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
      const encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
      return Buffer.concat([MAGIC,iv,cipher.getAuthTag(),encrypted]);
    }
    if(mode!=='unprotect'||bytes.length<32||!bytes.subarray(0,4).equals(MAGIC))throw Error('macOS钱包文件格式无效');
    const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(4,16));
    decipher.setAuthTag(bytes.subarray(16,32));
    return Buffer.concat([decipher.update(bytes.subarray(32)),decipher.final()]);
  }catch(error){
    if(mode==='unprotect'&&!String(error.message).includes('格式'))throw Error('无法解密钱包：钥匙串密钥不匹配或钱包文件已损坏');
    throw error;
  }finally{key.fill(0);}
}

export function crypt(mode,bytes){
  if(!['protect','unprotect'].includes(mode))throw Error('钱包加密模式无效');
  if(process.platform==='darwin')return macCrypt(mode,Buffer.from(bytes));
  if(process.platform==='win32'){
    const result=command('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve(ROOT,'scripts/wallet-vault.ps1'),'-Mode',mode],Buffer.from(bytes).toString('base64'));
    if(result.status!==0)throw Error('Windows钱包加解密失败。请使用创建钱包时的Windows账户；不要覆盖原钱包。');
    return Buffer.from(result.stdout.trim(),'base64');
  }
  throw Error('当前系统暂不支持本机钱包加密；请使用macOS或Windows');
}

export function walletProtection(){
  if(process.platform==='darwin')return 'AES-256-GCM · macOS钥匙串 · 需口令解锁';
  if(process.platform==='win32')return 'Windows DPAPI · 当前账户 · 需口令解锁';
  return '不支持的系统';
}
