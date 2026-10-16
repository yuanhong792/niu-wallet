// SPDX-License-Identifier: GPL-3.0-or-later
// Verify a private owner-review bundle without starting nodes or mining.
import {readFileSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import {resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]||'');assert.ok(process.argv[2],'Supply a bundle directory');
const read=name=>readFileSync(resolve(root,name));
const json=name=>JSON.parse(read(name));
const sha=data=>createHash('sha256').update(data).digest('hex');
const info=json('release-info.json'),manifest=json('manifest.json').files;
const actual=[];
function walk(dir){for(const entry of readdirSync(dir)){const path=resolve(dir,entry);assert.ok(!lstatSync(path).isSymbolicLink(),'Unexpected symlink');if(lstatSync(path).isDirectory())walk(path);else actual.push(relative(root,path).replaceAll('\\','/'));}}walk(root);
assert.deepEqual(actual.filter(name=>name!=='manifest.json').sort(),Object.keys(manifest).sort(),'Manifest file set mismatch');
for(const [name,hash] of Object.entries(manifest))assert.equal(sha(read(name)),hash,'Hash mismatch: '+name);
assert.ok(!existsSync(resolve(root,'runtime')),'Runtime data must not be shipped');
assert.ok(!actual.some(name=>name.endsWith('.dpapi')||['nodekey','jwtsecret'].includes(name.split('/').at(-1))),'Private wallet or node identity found');
for(const name of ['NiuWallet.exe','QRCoder.dll','engine/node.exe','bin/niu-geth-candidate.exe','network/genesis.json','assets/niu-gold-v4.png','assets/niu-gold-v4.ico'])assert.ok(existsSync(resolve(root,name)),name);
const exe=read('NiuWallet.exe'),pe=exe.readUInt32LE(0x3c);assert.equal(exe.toString('ascii',pe,pe+4),'PE\0\0');assert.equal(exe.readUInt16LE(pe+24+68),2,'Expected Windows GUI executable');
assert.equal(sha(exe),info.walletSha256);assert.equal(sha(read('bin/niu-geth-candidate.exe')),info.consensusNodeSha256);
assert.equal(info.mainnet,false);assert.equal(info.publicRelease,false);
const profile=json('network-config.json');assert.equal(profile.listenAddress,'127.0.0.1');assert.equal(profile.restrictPeerIPs,true);assert.equal(profile.advertiseIP,null);assert.deepEqual(profile.peers,[]);assert.deepEqual(profile.allowPeerIPs,[]);
assert.deepEqual(json('network/genesis.json').alloc,{});
console.log(JSON.stringify({status:'passed',files:actual.length,peSubsystem:'Windows GUI (2)',walletSha256:info.walletSha256,nodeSha256:info.consensusNodeSha256,privateRuntimeIncluded:false,loopbackOnly:true,mainnet:false,miningWasStarted:false},null,2));
