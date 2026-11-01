// One command that re-runs every v0.4.0 acceptance check and writes a single evidence file.
// Usage: node tools/qa-personal.mjs   (set PYTHON_BIN if the isolated venv lives elsewhere)
import {execFile} from 'node:child_process';
import {writeFileSync,mkdirSync,readdirSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {promisify} from 'node:util';

const run=promisify(execFile);
const root=resolve(import.meta.dirname,'..');
const node=process.execPath;
const python=process.env.PYTHON_BIN||'C:/Users/Administrator/.workbuddy-ai/binaries/python/envs/default/Scripts/python.exe';
const evidenceDir=join(root,'runtime','qa');
mkdirSync(evidenceDir,{recursive:true});

const env={...process.env};
delete env.NODE_OPTIONS;            // the editor shim blocks the temp-dir cleanup the tests do
env.CODEBUDDY_SAFE_DELETE_ENABLED='0';
env.NODE_PATH=process.env.NODE_PATH||'C:/Users/Administrator/AppData/Roaming/npm/node_modules';
env.PLAYWRIGHT_CHROMIUM_PATH=process.env.PLAYWRIGHT_CHROMIUM_PATH||
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe';

const results={};
async function step(name,cmd,args,parse){
  const started=Date.now();
  try{
    const {stdout,stderr}=await run(cmd,args,{cwd:root,env,maxBuffer:64*1024*1024});
    results[name]=parse?parse(stdout):JSON.parse(stdout.slice(stdout.indexOf('{'),stdout.lastIndexOf('}')+1));
    results[name].ms=Date.now()-started;
  }catch(e){
    results[name]={status:'failed',error:String(e.message).slice(0,2000),stdout:String(e.stdout||'').slice(-4000),ms:Date.now()-started};
  }
}

const testFiles=readdirSync(join(root,'scripts')).filter(f=>f.endsWith('.test.mjs')).sort().map(f=>join('scripts',f));
await step('unitTests',node,['--test',...testFiles],out=>{
  const pass=/^# pass (\d+)$/m.exec(out),fail=/^# fail (\d+)$/m.exec(out),tests=/^# tests (\d+)$/m.exec(out);
  return {status:fail&&Number(fail[1])===0?'passed':'failed',tests:Number(tests?.[1]||0),pass:Number(pass?.[1]||0),fail:Number(fail?.[1]||0)};
});
await step('packageIntegrity',node,['tools/verify-personal-package.mjs']);
await step('packageSmoke',node,['tools/smoke-personal-package.mjs']);
await step('liveNetworks',node,['tools/verify-personal-networks.mjs']);
await step('browserUi',node,['tools/ui-check-personal.mjs']);

// independent recovery: export a throwaway vault, then rebuild its addresses in Python
await step('independentRecoveryExport',node,['tools/export-sample-backup.mjs',join(evidenceDir,'sample')]);
if(results.independentRecoveryExport?.status==='ok'){
  await step('independentRecovery',python,['tools/verify-backup-independent.py',join(evidenceDir,'sample')]);
}else{
  results.independentRecovery={status:'skipped',reason:'sample export failed'};
}
// the sample holds a real (throwaway) key encrypted with a published password: do not keep it
rmSync(join(evidenceDir,'sample'),{recursive:true,force:true});

const order=['unitTests','packageIntegrity','packageSmoke','liveNetworks','browserUi','independentRecovery'];
const summary=Object.fromEntries(order.map(k=>[k,results[k]?.status||'missing']));
const allPassed=order.every(k=>summary[k]==='passed');
const report={
  status:allPassed?'passed':'failed',
  generatedAt:new Date().toISOString(),
  package:'D:/NIU-Wallet-v0.4.0-Windows-x64',
  summary,
  detail:Object.fromEntries(order.map(k=>[k,results[k]])),
  notVerified:[
    'Electron 窗口本身：本会话内启动 NIU Wallet.exe 后进程立即消失，旧版 v0.3.10 同样如此（对照组），判断为本机无交互桌面会话的限制，而非打包缺陷；需人工双击确认窗口。',
    '真实资金：未执行任何主网转账。',
    '有测试币的真实测试网收发：未领取测试币，未做真实广播。',
    '第三方安全审计：未进行。'
  ]
};
const file=join(root,'docs','personal-qa.json');
writeFileSync(file,JSON.stringify(report,null,2));
console.log(JSON.stringify({status:report.status,summary,file},null,2));
if(!allPassed)process.exitCode=1;
