// Rebuilds resources/app.asar in the existing v0.4.0 output folder without touching
// anything else. Use after editing desktop/main.cjs or desktop/package.json.
import {cpSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),asar=require('../desktop/node_modules/@electron/asar');
const root=resolve(import.meta.dirname,'..'),out='D:/NIU-Wallet-v0.4.0-Windows-x64';
if(!existsSync(out))throw Error('output missing, run tools/package-personal.mjs first');
const stage=join(root,'runtime','asar-personal');
mkdirSync(stage,{recursive:true});
cpSync(join(root,'desktop','main.cjs'),join(stage,'main.cjs'));
const manifest=JSON.parse(readFileSync(join(root,'desktop','package.json'),'utf8'));
delete manifest.build;delete manifest.devDependencies;delete manifest.dependencies;
writeFileSync(join(stage,'package.json'),JSON.stringify(manifest,null,2));
await asar.createPackage(stage,join(out,'resources','app.asar'));
console.log(JSON.stringify({rebuilt:join(out,'resources','app.asar'),version:manifest.version}));
