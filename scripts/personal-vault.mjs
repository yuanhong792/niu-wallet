import {randomBytes,scrypt as scryptCb,createCipheriv,createDecipheriv} from 'node:crypto';
import {promisify} from 'node:util';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {Wallet} from 'ethers';
import {ECPairFactory} from 'ecpair';
import * as ecc from 'tiny-secp256k1';
import {payments,networks} from 'bitcoinjs-lib';
import {DOGE_CHAIN} from './personal-networks.mjs';
const derive=promisify(scryptCb),pairs=ECPairFactory(ecc);
const policy={N:131072,r:8,p:1,maxmem:256*1024*1024};
function passwordCheck(p){if(typeof p!=='string'||p.length<12||Buffer.byteLength(p)>1024)throw Error('独立钱包口令至少12个字符');}
export function identities(secret){
  if(secret?.version!==1||!/^0x[0-9a-f]{64}$/i.test(secret.evm)||!/^[0-9a-f]{64}$/i.test(secret.btc))throw Error('个人钱包密钥格式无效');
  const pair=pairs.fromPrivateKey(Buffer.from(secret.btc,'hex'));
  return {evm:new Wallet(secret.evm).address,btc:payments.p2wpkh({pubkey:pair.publicKey,network:networks.bitcoin}).address,btcTest:payments.p2wpkh({pubkey:pair.publicKey,network:networks.testnet}).address,doge:payments.p2pkh({pubkey:pair.publicKey,network:DOGE_CHAIN}).address};
}
export async function seal(secret,password){
  passwordCheck(password); identities(secret);
  const salt=randomBytes(32),iv=randomBytes(12),key=await derive(password,salt,32,policy);
  try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('niu-personal-v1'));
    const bytes=Buffer.from(JSON.stringify(secret));
    try{const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);return {format:'niu-personal-vault',version:1,kdf:'scrypt-131072-8-1',salt:salt.toString('hex'),iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('hex')};}finally{bytes.fill(0);}
  }finally{key.fill(0);}
}
export async function open(envelope,password){
  passwordCheck(password);
  if(envelope?.format!=='niu-personal-vault'||envelope.version!==1||envelope.kdf!=='scrypt-131072-8-1'||!/^[0-9a-f]{64}$/.test(envelope.salt)||!/^[0-9a-f]{24}$/.test(envelope.iv)||!/^[0-9a-f]{32}$/.test(envelope.tag)||!/^[0-9a-f]{2,4096}$/.test(envelope.ciphertext)||envelope.ciphertext.length%2)throw Error('备份格式无效或不支持；此处只接受个人多链备份');
  const key=await derive(password,Buffer.from(envelope.salt,'hex'),32,policy);
  try{const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'hex'));decipher.setAAD(Buffer.from('niu-personal-v1'));decipher.setAuthTag(Buffer.from(envelope.tag,'hex'));
    let plain;try{plain=Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'hex')),decipher.final()]);const secret=JSON.parse(plain.toString());identities(secret);return secret;}finally{plain?.fill(0);}
  }catch{throw Error('口令不正确或备份已损坏');}finally{key.fill(0);}
}
export class PersonalVault{
  constructor(file){this.file=file;this.secret=null;this.timer=null;this.addresses=null;}
  present(){return existsSync(this.file);}
  store(envelope){mkdirSync(dirname(this.file),{recursive:true});writeFileSync(this.file+'.new',JSON.stringify(envelope),{mode:0o600,flag:'wx'});renameSync(this.file+'.new',this.file);}
  async create(password){if(this.present())throw Error('已有个人钱包，请解锁或在独立目录恢复');
    const secret={version:1,evm:new Wallet('0x'+randomBytes(32).toString('hex')).privateKey,btc:Buffer.from(pairs.makeRandom({rng:n=>randomBytes(n)}).privateKey).toString('hex')};
    const envelope=await seal(secret,password);this.store(envelope);this.secret=secret;this.addresses=identities(secret);this.touch();return this.addresses;}
  async unlock(password){if(!this.present())throw Error('请先创建个人钱包');this.secret=await open(JSON.parse(readFileSync(this.file,'utf8')),password);this.addresses=identities(this.secret);this.touch();return this.addresses;}
  touch(){clearTimeout(this.timer);this.timer=setTimeout(()=>this.lock(),5*60*1000);this.timer.unref();}
  require(){if(!this.secret)throw Error('个人钱包已锁定，请先解锁');this.touch();return this.secret;}
  lock(){clearTimeout(this.timer);this.secret=null;}
  async backup(password){this.require();return seal(this.secret,password);}
  async restore(text,password){if(this.present())throw Error('已有个人钱包，拒绝覆盖；请在另一台电脑或独立数据目录恢复');if(typeof text!=='string'||Buffer.byteLength(text)>16384)throw Error('备份文件无效');const secret=await open(JSON.parse(text),password);this.store(await seal(secret,password));this.secret=secret;this.addresses=identities(secret);this.touch();return this.addresses;}
}
