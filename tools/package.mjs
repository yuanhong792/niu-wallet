// SPDX-License-Identifier: GPL-3.0-or-later
// Run npm ci first. Then node tools/package.mjs --geth <geth.exe> --upstream <pinned core-geth checkout> --node-license <Node LICENSE>
import {mkdirSync,readFileSync,writeFileSync,readdirSync,statSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i]]=process.argv[i+1];
for(const name of ['--geth','--upstream','--node-license'])if(!args[name])throw Error('Required '+name);
const tag=args['--tag']||'0.3.0-desktop-alpha',folder=`NIU-Wallet-${tag}-win-x64`;
if(!/^[a-zA-Z0-9.-]+$/.test(tag))throw Error('Invalid build tag');
const dest=resolve(root,'dist',folder);if(existsSync(dest))throw Error('Output already exists; choose a new clean build directory.');
mkdirSync(dest,{recursive:true});
function copy(from,to){if(statSync(from).isDirectory()){mkdirSync(to,{recursive:true});for(const n of readdirSync(from))copy(resolve(from,n),resolve(to,n));}else writeFileSync(to,readFileSync(from));}
for(const name of ['scripts','public','contracts','tools','assets','vendor','network','node','node_modules','package.json','package-lock.json','README.md','LICENSE'])copy(resolve(root,name),resolve(dest,name));
copy(resolve(root,'vendor/QRCoder.dll'),resolve(dest,'QRCoder.dll'));
mkdirSync(resolve(dest,'engine'));mkdirSync(resolve(dest,'bin'));mkdirSync(resolve(dest,'licenses'));
copy(process.execPath,resolve(dest,'engine/node.exe'));
copy(resolve(args['--geth']),resolve(dest,'bin/geth.exe'));
copy(resolve(args['--node-license']),resolve(dest,'licenses/NODE-LICENSE.txt'));
for(const name of ['COPYING','COPYING.LESSER'])copy(resolve(args['--upstream'],name),resolve(dest,'licenses','CORE-GETH-'+name));
const revision=spawnSync('git',['-C',resolve(args['--upstream']),'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true});
if(revision.stdout.trim()!=='96b2afc25c7023bb500d14e8ed69455339b1ca90')throw Error('Unexpected core-geth source revision');
// node/ contains the actual modified corresponding source, not an archive of
// upstream HEAD that silently omits NIU consensus changes.
const compile=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-File',resolve(root,'tools/compile-launcher.ps1'),'-Source',resolve(root,'tools/launcher.cs'),'-Output',resolve(dest,'NiuWallet.exe')],{encoding:'utf8',windowsHide:true});
if(compile.status!==0)throw Error(compile.stderr||'Launcher compile failed');
writeFileSync(resolve(dest,'release-info.json'),JSON.stringify({version:tag,platform:'windows-x64',node:process.version,coreGeth:'v1.12.23',coreGethCommit:revision.stdout.trim(),chainId:26261015,
  scope:'Independent local-only experience, no shared network; planned supply/reward rules NOT implemented',
  wallet:'Generated on first run; Windows DPAPI CurrentUser; no keys or data shipped',signed:false},null,2));
const manifest={};function walk(dir,prefix=''){for(const n of readdirSync(dir)){const path=resolve(dir,n),name=prefix+n;if(statSync(path).isDirectory())walk(path,name+'/');else manifest[name]=createHash('sha256').update(readFileSync(path)).digest('hex');}}walk(dest);
writeFileSync(resolve(dest,'manifest.json'),JSON.stringify({files:manifest},null,2));
console.log(dest);
