// Packages the coordinator build as a ZIP using the .NET API so the archive is
// created without touching the source tree.
import {readdirSync,statSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join,relative,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const src=resolve(root,'dist/NIU-Wallet-0.3.3-owner-review-win-x64');
const out=resolve(root,'dist/NIU-Wallet-0.3.4-lock-win-x64.zip');
if(!existsSync(src))throw Error(`源目录不存在: ${src}`);

const ps=`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$src='${src.replace(/\\/g,'\\\\')}'
$out='${out.replace(/\\/g,'\\\\')}'
if(Test-Path -LiteralPath $out){Remove-Item -LiteralPath $out -Force}
[System.IO.Compression.ZipFile]::CreateFromDirectory($src,$out,[System.IO.Compression.CompressionLevel]::Optimal,$false)
Write-Output 'OK'
`;
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{encoding:'utf8',timeout:600000,stdio:['ignore','pipe','inherit']});

const bytes=readFileSync(out);
console.log(`生成: ${out}`);
console.log(`大小: ${(bytes.length/1048576).toFixed(1)} MB`);
console.log(`SHA256: ${createHash('sha256').update(bytes).digest('hex')}`);
console.log(`来源: ${src}`);
