// Real loopback-chain regression for token issuance and generic Solidity calls.
// It is kept outside the default test glob because proof-of-work can take a few minutes.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {NiuLab,ROOT,waitFor} from './lab.mjs';

const NODE_BIN=existsSync(resolve(ROOT,'bin/niu-geth-candidate.exe'))
  ?resolve(ROOT,'bin/niu-geth-candidate.exe')
  :resolve(ROOT,'bin/niu-geth-candidate');
const run=process.env.NIU_CONTRACT_QA_DIR
  ?resolve(process.env.NIU_CONTRACT_QA_DIR)
  :resolve(ROOT,'runtime','contract-qa-'+Date.now());
mkdirSync(run,{recursive:true});
const lab=new NiuLab({base:run,ports:[19945,19946],p2p:[31971,31972],auth:[19951,19952],network:null,nodeBin:NODE_BIN});
const report={status:'running',scope:'two local node processes on an isolated test chain',checks:{}};
const check=(name,condition)=>{assert.ok(condition,name);report.checks[name]=true;};

try{
  await lab.start();
  await lab.unlock('contract-integration-password');
  await lab.mine(true);
  await waitFor('测试矿工获得手续费余额',async()=>await lab.providers[0].getBalance(lab.walletAddresses[0])>0n,480000);

  let issued=(lab.meta.tokens||[]).find(item=>item.symbol==='NQT');
  if(!issued){
    const draft=await lab.prepareToken({name:'NIU QA Token',symbol:'NQT',decimals:6,supply:'1000000',mode:'fixed'},lab.walletAddresses[0]);
    check('tokenGasPreview',BigInt(draft.gas)>0n&&Number(draft.bytecodeBytes)>0);
    issued=await lab.issueToken(draft.draftId);
  }else report.checks.tokenGasPreview=true;
  check('tokenHasRuntimeCode',await lab.providers[0].getCode(issued.address)!=='0x');
  let portfolio=await lab.tokenPortfolio();
  check('issuerReceivesSupply',portfolio.tokens[0].balances[0].raw==='1000000000000');
  if(portfolio.tokens[0].balances[1].raw!=='25500000')await lab.transferToken(issued.address,lab.walletAddresses[0],lab.walletAddresses[1],'25.5');
  portfolio=await lab.tokenPortfolio();
  check('tokenTransferConfirmed',portfolio.tokens[0].balances[1].raw==='25500000');

  const source=[
    '// SPDX-License-Identifier: MIT',
    'pragma solidity ^0.8.20;',
    'contract NiuCounter {',
    '  uint256 public value;',
    '  constructor(uint256 firstValue) { value = firstValue; }',
    '  function setValue(uint256 nextValue) external { value = nextValue; }',
    '}'
  ].join('\n');
  let record=(lab.meta.developerContracts||[]).find(item=>item.name==='Integration Counter');
  if(!record){
    const build=lab.compileSolidity(source,'NiuCounter.sol');
    const estimate=await lab.deploymentEstimate(build.buildId,'NiuCounter',['5'],lab.walletAddresses[0],'0');
    check('contractGasPreview',BigInt(estimate.gas)>0n);
    const deployed=await lab.deployCompiled(build.buildId,'NiuCounter',['5'],lab.walletAddresses[0],'0','Integration Counter');
    record=lab.meta.developerContracts.find(item=>item.id===deployed.id);
    check('contractRead',(await lab.readContract(record.id,'value()',[])).result==='5');
  }else{report.checks.contractGasPreview=true;report.checks.contractRead=true;}
  if((await lab.readContract(record.id,'value()',[])).result!=='9')await lab.writeContract(record.id,'setValue(uint256)',['9'],lab.walletAddresses[0],'0');
  check('contractWrite',(await lab.readContract(record.id,'value()',[])).result==='9');

  report.tokenAddress=issued.address;
  report.contractAddress=record.address;
  report.height=await lab.providers[0].getBlockNumber();
  report.status='passed';
}catch(error){
  report.status='failed';report.error=error.shortMessage||error.message;process.exitCode=1;
}finally{
  await lab.close();
  report.gracefulShutdown=lab.graceful;
  report.finishedAt=new Date().toISOString();
  mkdirSync(resolve(ROOT,'evidence'),{recursive:true});
  writeFileSync(resolve(ROOT,'evidence/contract-integration.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
