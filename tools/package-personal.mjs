import {cpSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),asar=require('../desktop/node_modules/@electron/asar');
const root=resolve(import.meta.dirname,'..'),original='D:/NIU-Wallet-v0.3.10-Windows-x64';
const out='D:/NIU-Wallet-v0.4.0-Windows-x64';
if(existsSync(out))throw Error('Output already exists; refusing overwrite: '+out);
mkdirSync(out,{recursive:true});
for(const f of readdirSync(original,{withFileTypes:true})){
  if(f.isFile()&&!['niu_tree.json'].includes(f.name))cpSync(join(original,f.name),join(out,f.name));
}
cpSync(join(original,'locales'),join(out,'locales'),{recursive:true});
const resources=join(out,'resources','app-resources');mkdirSync(resources,{recursive:true});
for(const folder of ['scripts','public','contracts','network','assets','node_modules'])cpSync(join(root,folder),join(resources,folder),{recursive:true});
mkdirSync(join(resources,'bin'));cpSync(join(root,'bin','niu-geth-candidate.exe'),join(resources,'bin','niu-geth-candidate.exe'));
for(const f of ['package.json','package-lock.json'])cpSync(join(root,f),join(resources,f));
cpSync(join(root,'network','network-config.release.json'),join(resources,'network-config.json'));
const stage=join(root,'runtime','asar-personal');mkdirSync(stage,{recursive:true});
cpSync(join(root,'desktop','main.cjs'),join(stage,'main.cjs'));
const manifest=JSON.parse(readFileSync(join(root,'desktop','package.json'),'utf8'));
delete manifest.build;delete manifest.devDependencies;delete manifest.dependencies;
writeFileSync(join(stage,'package.json'),JSON.stringify(manifest,null,2));
await asar.createPackage(stage,join(out,'resources','app.asar'));
console.log(JSON.stringify({out,version:manifest.version,runtime:'Reused unchanged Electron runtime from installed NIU v0.3.10; app.asar and business resources rebuilt.'}));
