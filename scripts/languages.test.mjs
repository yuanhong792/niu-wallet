import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const languageCodes=['zh-CN','en','ja','ko','es','ru'];

test('Chinese wallet UI includes current network, backup and transaction-detail wording',()=>{
 for(const phrase of ['牛币钱包','牛链网络','交易记录','点击任意交易可查看完整链上明细','导入钱包'])
  assert.ok((html+app).includes(phrase),phrase);
 for(const phrase of ['交易哈希','区块哈希','转出方','收款方','手续费','输入数据'])
  assert.ok(app.includes(phrase),phrase);
 assert.equal((html+app).includes('本地测试网'),false);
 assert.equal((html+app).includes('\uFFFD'),false);
 assert.ok(app.includes('恢复测试版使用独立数据目录'));
});

test('portable backup prompts consistently require a 12-character password',()=>{
 assert.ok(app.includes('设置备份口令（至少 12 位）'));
 assert.ok(app.includes('备份文件密码（至少 12 位）'));
 assert.equal(app.includes('口令至少 8 位'),false);
});

test('desktop settings expose six persistent interface languages',()=>{
 assert.match(html,/id="languageSelect"/);
 for(const code of languageCodes)assert.match(html,new RegExp(`value="${code}"`));
 assert.ok(app.includes("localStorage.setItem(LANGUAGE_STORE, code)"));
 assert.ok(app.includes("fetch('/locales/'"));
});

test('every visible static Chinese label has all six translations',()=>{
 const nativeNames=new Set(['简体中文','日本語']);
 const keys=new Set();
 for(const match of html.matchAll(/>([^<>]+)</g)){
  const value=match[1].trim();
  if(/[\u3400-\u9fff]/.test(value)&&!nativeNames.has(value))keys.add(value);
 }
 for(const match of html.matchAll(/(?:placeholder|aria-label|title)="([^"]+)"/g)){
  if(/[\u3400-\u9fff]/.test(match[1]))keys.add(match[1]);
 }
 for(const code of languageCodes){
  const catalog=JSON.parse(readFileSync(new URL(`../assets/locales/${code}.json`,import.meta.url),'utf8'));
  for(const key of keys)assert.equal(typeof catalog[key],'string',`${code}: ${key}`);
  assert.equal(Object.values(catalog).some(value=>String(value).includes('\uFFFD')),false,code);
 }
});
