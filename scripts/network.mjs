// SPDX-License-Identifier: GPL-3.0-or-later
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import net from 'node:net';

// A node key is the 64-byte uncompressed secp256k1 public key, stored as X||Y.
// Matching the 128-hex shape is not enough: a mistyped key is still valid hex
// but is not a point on the curve, and the node then aborts at startup with an
// opaque "invalid public key" fatal instead of a usable configuration error.
const CURVE_P=2n**256n-2n**32n-977n;
export function validNodeKey(key){
  if(typeof key!=='string'||!/^[0-9a-fA-F]{128}$/.test(key))return false;
  const x=BigInt('0x'+key.slice(0,64));
  const y=BigInt('0x'+key.slice(64));
  if(x>=CURVE_P||y>=CURVE_P)return false;
  return (y*y)%CURVE_P===(x*x*x+7n)%CURVE_P;
}

export function validateNetwork(value) {
  if(value?.version!==1||value.chainId!==26261017||value.networkId!==26261017||
    !/^0x[0-9a-f]{64}$/i.test(value.genesisHash||''))throw Error('牛链网络标识不兼容');
  if(!Array.isArray(value.peers)||value.peers.length>32)throw Error('节点列表无效');
  const peerIPs=[];
  for(const peer of value.peers) {
    const m=typeof peer==='string'&&peer.match(/^enode:\/\/([a-fA-F0-9]{128})@([0-9.]+):([0-9]+)(?:\?discport=([0-9]+))?$/);
    if(!m||net.isIP(m[2])!==4||Number(m[3])<1||Number(m[3])>65535||(m[4]!==undefined&&Number(m[4])>65535))throw Error('节点地址须为有效IPv4 enode');
    if(!validNodeKey(m[1]))throw Error('节点地址中的公钥无效，请核对 enode 是否被截断或抄错');
    peerIPs.push(m[2]);
  }
  if(!['127.0.0.1','0.0.0.0'].includes(value.listenAddress))throw Error('节点监听地址无效');
  if(typeof value.coordinator!=='boolean')throw Error('引导节点选项无效');
  if(typeof value.restrictPeerIPs!=='boolean')throw Error('节点IP限制选项无效');
  if(!value.peers.length&&!value.coordinator)throw Error('尚未配置引导节点，不能启动牛链网络');
  if(!Array.isArray(value.allowPeerIPs)||value.allowPeerIPs.some(ip=>net.isIP(ip)!==4))throw Error('允许接入的IP无效');
  if(value.advertiseIP!==null&&net.isIP(value.advertiseIP)!==4)throw Error('对外节点IP无效');
  return {...value,peers:[...new Set(value.peers)],peerIPs:[...new Set([...peerIPs,...value.allowPeerIPs])]};
}
export function loadNetwork(root) {
  const path=resolve(root,'network-config.json');
  if(!existsSync(path))return null;
  // Notepad and PowerShell's "Set-Content -Encoding UTF8" both write a BOM, and
  // JSON.parse rejects one with a bare "Unexpected token". Users are expected to
  // hand-edit this file, so strip it instead of failing with a cryptic error.
  const text=readFileSync(path,'utf8').replace(/^\uFEFF/,'');
  return validateNetwork(JSON.parse(text));
}
// Core-Geth may report an all-zero progress object on a fresh genesis. Treat
// actual missing blocks, not object truthiness, as a mining/sending backlog.
export function syncPending(value) {
  if(value===false)return false;
  try{return BigInt(value.highestBlock)>BigInt(value.currentBlock);}catch{return true;}
}
export function p2pConfig(profile,port) {
  return `[Node.P2P]\nListenAddr = "${profile.listenAddress}:${port}"\nNoDiscovery = true\nStaticNodes = ${JSON.stringify(profile.peers)}\n`;
}
