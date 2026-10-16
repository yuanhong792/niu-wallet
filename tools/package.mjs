// SPDX-License-Identifier: GPL-3.0-or-later
// Private owner review bundle only. This tool does not publish a GitHub Release.
// node tools/package.mjs --niu-geth <verified-node.exe> --node-license <Node LICENSE> [--tag <owner-review-tag>]
import {mkdirSync,readFileSync,writeFileSync,readdirSync,lstatSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateNetwork} from '../scripts/network.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args={};for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i+1])throw Error('Missing argument value');args[process.argv[i]]=process.argv[i+1];}
for(const name of ['--niu-geth','--node-license'])if(!args[name])throw Error('Required '+name);
for(const name of Object.keys(args))if(!['--niu-geth','--node-license','--tag'].includes(name))throw Error('Unknown argument '+name);
const tag=args['--tag']||'0.3.3-owner-review',folder=`NIU-Wallet-${tag}-win-x64`;
if(!/^[a-zA-Z0-9.-]+$/.test(tag)||!tag.includes('owner-review'))throw Error('Only explicitly labelled owner-review builds are supported');
const dest=resolve(root,'dist',folder);if(existsSync(dest))throw Error('Output already exists; choose a clean build tag');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const nodePath=resolve(args['--niu-geth']),nodeBytes=readFileSync(nodePath);
const evidence=JSON.parse(readFileSync(resolve(root,'docs/security-build-evidence.json'),'utf8'));
if(sha(nodeBytes)!==evidence.sha256||evidence.binaryReachableFindings!==0||evidence.sourceReachableFindings!==0)throw Error('Node does not match the scanned build');
const version=spawnSync(nodePath,['version'],{encoding:'utf8',windowsHide:true});
if(version.status!==0||!version.stdout.includes('niu-rules1-candidate'))throw Error('Incorrect NIU consensus binary');
const git=spawnSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true});
if(git.status!==0)throw Error('Cannot identify source commit');
const listed=spawnSync('git',['-C',root,'ls-files','-z'],{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
if(listed.status!==0)throw Error('Cannot enumerate corresponding source');
function copy(from,to){const stat=lstatSync(from);if(stat.isSymbolicLink())throw Error('Symlinks are not allowed in release input');if(stat.isDirectory()){mkdirSync(to,{recursive:true});for(const n of readdirSync(from))copy(resolve(from,n),resolve(to,n));}else{mkdirSync(dirname(to),{recursive:true});writeFileSync(to,readFileSync(from));}}
mkdirSync(dest,{recursive:true});
for(const name of listed.stdout.split('\0').filter(Boolean)) {
 if(/^(scripts|public|contracts|tools|assets|vendor|network|node|docs)\//.test(name)||['package.json','package-lock.json','README.md','SECURITY.md','LICENSE'].includes(name))copy(resolve(root,name),resolve(dest,name));
}
// Dependencies are installed from the pinned lockfile; no runtime state or wallet is copied.
copy(resolve(root,'node_modules'),resolve(dest,'node_modules'));
copy(resolve(root,'vendor/QRCoder.dll'),resolve(dest,'QRCoder.dll'));
copy(process.execPath,resolve(dest,'engine/node.exe'));
copy(nodePath,resolve(dest,'bin/niu-geth-candidate.exe'));
copy(resolve(args['--node-license']),resolve(dest,'licenses/NODE-LICENSE.txt'));
for(const name of ['COPYING','COPYING.LESSER'])copy(resolve(root,'node',name),resolve(dest,'licenses','CORE-GETH-'+name));
const profile=validateNetwork({...JSON.parse(readFileSync(resolve(root,'network/network-config.example.json'),'utf8')),coordinator:true});
writeFileSync(resolve(dest,'network-config.json'),JSON.stringify(profile,null,2));
const compile=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',resolve(root,'tools/compile-launcher.ps1'),'-Source',resolve(root,'tools/launcher.cs'),'-Output',resolve(dest,'NiuWallet.exe')],{encoding:'utf8',windowsHide:true});
if(compile.status!==0)throw Error(compile.stderr||'Launcher compile failed');
const data=readFileSync(resolve(dest,'NiuWallet.exe')),pe=data.readUInt32LE(0x3c),optional=pe+24;
if(data.toString('ascii',pe,pe+4)!=='PE\0\0'||data.readUInt16LE(optional+68)!==2)throw Error('Wallet is not a Windows GUI executable');
writeFileSync(resolve(dest,'release-info.json'),JSON.stringify({version:tag,platform:'windows-x64',node:process.version,sourceCommit:git.stdout.trim(),sourceIncludesWorkingTree:true,consensusNodeSha256:sha(nodeBytes),walletSha256:sha(data),chainId:26261017,genesisHash:profile.genesisHash,
 scope:'Private owner review. This is the already-tested integration network, NOT a fresh official mainnet. No public release or first-official-block claim.',
 wallet:'Native Windows Forms EXE. Keys generated locally on first run. No runtime, real wallet keys, backups, balances or developer chain database shipped. Vendored upstream source includes public test vectors.',
 network:'Loopback only; discovery disabled; no static peers; mining off by default.',mainnet:false,publicRelease:false,signed:false,peSubsystem:'Windows GUI (2)',languages:['zh-CN','en','ja','ko','es','ru']},null,2));
const manifest={};function walk(dir,prefix=''){for(const n of readdirSync(dir)){const path=resolve(dir,n),name=prefix+n;if(lstatSync(path).isDirectory())walk(path,name+'/');else manifest[name]=sha(readFileSync(path));}}walk(dest);
if(Object.keys(manifest).some(n=>n.startsWith('runtime/')||n.endsWith('.dpapi')||n==='nodekey'))throw Error('Private runtime data included');
writeFileSync(resolve(dest,'manifest.json'),JSON.stringify({files:manifest},null,2));
console.log(dest);
