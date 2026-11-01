// Verify the packaged v0.4.0 desktop bundle matches the source tree byte-for-byte.
// Read-only: reports mismatches, never modifies the package.
import {readFileSync,existsSync,readdirSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,relative} from 'node:path';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const asar=require('../desktop/node_modules/@electron/asar');
const root=resolve(import.meta.dirname,'..');
const out='D:/NIU-Wallet-v0.4.0-Windows-x64';
const res=join(out,'resources','app-resources');
const failures=[];

function walk(dir,base=dir,acc=[]){
  for(const entry of readdirSync(dir,{withFileTypes:true})){
    const full=join(dir,entry.name);
    if(entry.isDirectory())walk(full,base,acc);else acc.push(relative(base,full));
  }
  return acc;
}
function hash(file){return createHash('sha256').update(readFileSync(file)).digest('hex');}

if(!existsSync(out))failures.push('package directory missing: '+out);

// 1. business folders must match source exactly (same file set, same bytes)
const folders=[];
for(const folder of ['scripts','public','contracts','network','assets','node_modules','bin']){
  const srcDir=join(root,folder),dstDir=join(res,folder);
  if(!existsSync(dstDir)){failures.push(`missing folder in package: ${folder}`);continue;}
  const srcFiles=new Set(walk(srcDir)),dstFiles=new Set(walk(dstDir));
  for(const f of srcFiles)if(!dstFiles.has(f))failures.push(`missing in package: ${folder}/${f}`);
  for(const f of dstFiles)if(!srcFiles.has(f))failures.push(`extra in package: ${folder}/${f}`);
  let compared=0;
  for(const f of srcFiles){
    if(!dstFiles.has(f))continue;
    const a=join(srcDir,f),b=join(dstDir,f);
    if(statSync(a).size!==statSync(b).size||hash(a)!==hash(b)){failures.push(`content differs: ${folder}/${f}`);}
    compared++;
  }
  folders.push({folder,compared});
}
// 2. top-level manifests
for(const f of ['package.json','package-lock.json']){
  const a=join(root,f),b=join(res,f);
  if(!existsSync(b))failures.push('missing in package: '+f);
  else if(hash(a)!==hash(b))failures.push('content differs: '+f);
}
const releaseConfig=join(root,'network','network-config.release.json');
if(!existsSync(join(res,'network-config.json')))failures.push('missing in package: network-config.json');
else if(hash(releaseConfig)!==hash(join(res,'network-config.json')))failures.push('network-config.json is not the release config');

// 3. electron wrapper must be the current main.cjs, versioned 0.4.0
const asarPath=join(out,'resources','app.asar');
if(!existsSync(asarPath))failures.push('missing app.asar');
else{
  const packedMain=asar.extractFile(asarPath,'main.cjs').toString('utf8');
  if(packedMain!==readFileSync(join(root,'desktop','main.cjs'),'utf8'))failures.push('app.asar main.cjs is stale');
  const manifest=JSON.parse(asar.extractFile(asarPath,'package.json').toString('utf8'));
  if(manifest.version!=='0.4.0')failures.push('app.asar version is '+manifest.version);
  if(manifest.dependencies||manifest.devDependencies||manifest.build)failures.push('app.asar manifest still carries dependencies/build config');
}

// 4. runtime binaries must be present
for(const f of ['NIU Wallet.exe','resources.pak','icudtl.dat'])if(!existsSync(join(out,f)))failures.push('missing runtime file: '+f);

const report={status:failures.length?'failed':'passed',checkedAt:new Date().toISOString(),filesCompared:folders.reduce((n,f)=>n+f.compared,0),folders,failures};
console.log(JSON.stringify(report,null,2));
if(failures.length)process.exitCode=1;
