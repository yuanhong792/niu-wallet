import test from 'node:test';
import assert from 'node:assert/strict';
import {ContractStudio} from './contract-studio.mjs';
import {ROOT} from './lab.mjs';

test('contract studio compiles a single-file London contract',()=>{
  const studio=new ContractStudio(ROOT);
  const result=studio.compile('pragma solidity ^0.8.20; contract Counter { uint public value; constructor(uint first){value=first;} function add() external { value++; } }');
  assert.equal(result.evmVersion,'london');
  assert.equal(result.artifacts[0].name,'Counter');
  assert.equal(result.artifacts[0].constructorInputs[0].type,'uint256');
  assert.ok(result.artifacts[0].bytecodeBytes>0);
  assert.equal(studio.artifact(result.buildId,'Counter').build.sourceHash,result.sourceHash);
});

test('one-click token templates compile against the pinned OpenZeppelin library',()=>{
  const studio=new ContractStudio(ROOT);
  const fixed=studio.compileTemplate('fixed');
  const managed=studio.compileTemplate('managed');
  assert.equal(fixed.artifacts[0].name,'NiuFixedToken');
  assert.equal(managed.artifacts[0].name,'NiuManagedToken');
  assert.ok(managed.artifacts[0].abi.some(item=>item.name==='mint'));
  assert.ok(managed.artifacts[0].abi.some(item=>item.name==='pause'));
});

test('contract studio refuses oversized source and non-allowlisted imports',()=>{
  const studio=new ContractStudio(ROOT);
  assert.throws(()=>studio.compile('x'.repeat(128*1024+1)),/128KB/);
  assert.throws(()=>studio.compile('pragma solidity ^0.8.20; import "../../secret.sol"; contract X {}'),/只允许导入/);
});
