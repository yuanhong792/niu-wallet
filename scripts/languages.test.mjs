import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const languages=['zh-CN','en','ja','ko','es','ru'];
const catalogs=Object.fromEntries(languages.map(code=>[code,JSON.parse(readFileSync(new URL('../assets/locales/'+code+'.json',import.meta.url),'utf8'))]));
test('all six embedded catalogs cover UI strings and transaction types',()=>{
 const source=readFileSync(new URL('../tools/launcher.cs',import.meta.url),'utf8');
 const keys=[...source.matchAll(/NiuLanguage\.T\(("(?:[^"\\]|\\.)*")\)/g)].map(m=>JSON.parse(m[1]));
 assert.ok(keys.length>100,'UI literal extraction must cover the wallet');
 for(const [code,catalog] of Object.entries(catalogs)) {
  assert.deepEqual(Object.keys(catalog).sort(),Object.keys(catalogs['zh-CN']).sort(),code);
  for(const key of [...keys,'转账','部署合约','更新留言'])assert.ok(typeof catalog[key]==='string'&&catalog[key].trim().length>0,code+': '+key);
  for(const value of Object.values(catalog))assert.ok(!value.includes('\uFFFD'),code+' has corrupted text');
 }
});
test('localized backup file filters and transfer confirmation separators remain valid',()=>{
 for(const [code,catalog] of Object.entries(catalogs)) {
  assert.ok(catalog['牛币加密备份 (*.json)|*.json'].endsWith('(*.json)|*.json'),code);
  assert.ok(catalog['\n收款地址：'].startsWith('\n'),code);
  assert.ok(catalog[' NIU\n\n确认后签名并广播，交易还需要支付手续费。'].includes('\n\n'),code);
 }
});
