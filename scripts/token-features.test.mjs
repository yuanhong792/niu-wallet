import test from 'node:test';
import assert from 'node:assert/strict';
import {NiuLab} from './lab.mjs';

const lab=new NiuLab({network:null});

test('one-click token options normalize fixed and managed ERC-20 settings',()=>{
  const fixed=lab.tokenOptions({name:'Niu Points',symbol:'niu',decimals:'18',supply:'1000000',mode:'fixed'});
  assert.equal(fixed.symbol,'NIU');
  assert.equal(fixed.initialUnits,1000000n*10n**18n);
  assert.equal(fixed.capUnits,fixed.initialUnits);

  const managed=lab.tokenOptions({name:'Community Credit',symbol:'cc',decimals:6,supply:'100',cap:'1000',mode:'managed'});
  assert.equal(managed.mode,'managed');
  assert.equal(managed.initialUnits,100000000n);
  assert.equal(managed.capUnits,1000000000n);
});

test('one-click token options reject unsafe or impossible values',()=>{
  assert.throws(()=>lab.tokenOptions({name:'X',symbol:'X',decimals:18,supply:'1',mode:'fixed'}),/代币符号/);
  assert.throws(()=>lab.tokenOptions({name:'X',symbol:'XX',decimals:19,supply:'1',mode:'fixed'}),/小数位/);
  assert.throws(()=>lab.tokenOptions({name:'X',symbol:'XX',decimals:'',supply:'1',mode:'fixed'}),/小数位/);
  assert.throws(()=>lab.tokenOptions({name:'X',symbol:'XX',decimals:18,supply:'1',mode:'unknown'}),/发行模式/);
  assert.throws(()=>lab.tokenOptions({name:'X',symbol:'XX',decimals:18,supply:'0',mode:'fixed'}),/必须大于0/);
  assert.throws(()=>lab.tokenOptions({name:'X',symbol:'XX',decimals:18,supply:'2',cap:'1',mode:'managed'}),/不能小于/);
  assert.throws(()=>lab.tokenOptions({name:'X',symbol:'XX',decimals:0,supply:(1n<<256n).toString(),mode:'fixed'}),/最大值/);
});
