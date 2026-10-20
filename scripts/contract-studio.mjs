import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import solc from 'solc';

const MAX_SOURCE_BYTES=128*1024;
const MAX_BYTECODE_BYTES=48*1024;
const MAX_RUNTIME_BYTES=24*1024;
const BUILD_TTL_MS=20*60*1000;
const MAX_BUILDS=20;

function cleanFileName(value){
  if(typeof value!=='string'||!/^[A-Za-z_][A-Za-z0-9_-]{0,63}\.sol$/.test(value))return 'UserContract.sol';
  return value;
}

function compilerText(item){
  return String(item.formattedMessage||item.message||'Solidity compiler message').slice(0,8000);
}

export class ContractStudio {
  constructor(root){
    this.root=root;
    this.ozRoot=resolve(root,'node_modules/@openzeppelin/contracts');
    this.builds=new Map();
  }

  importFile(importPath){
    const prefix='@openzeppelin/contracts/';
    if(typeof importPath!=='string'||!importPath.startsWith(prefix))return {error:'只允许导入 @openzeppelin/contracts 中的合约'};
    const relative=importPath.slice(prefix.length);
    if(!relative||relative.includes('..')||!relative.endsWith('.sol'))return {error:'Solidity 导入路径无效'};
    const file=resolve(this.ozRoot,relative);
    if(file!==this.ozRoot&&!file.startsWith(this.ozRoot+sep))return {error:'Solidity 导入路径越界'};
    try{return {contents:readFileSync(file,'utf8')};}catch{return {error:`找不到依赖：${importPath}`};}
  }

  prune(){
    const now=Date.now();
    for(const [id,build] of this.builds)if(now-build.createdAt>BUILD_TTL_MS)this.builds.delete(id);
    while(this.builds.size>=MAX_BUILDS)this.builds.delete(this.builds.keys().next().value);
  }

  compile(source,fileName='UserContract.sol'){
    if(typeof source!=='string'||!source.trim())throw Error('Solidity 源码不能为空');
    if(Buffer.byteLength(source)>MAX_SOURCE_BYTES)throw Error('Solidity 源码不能超过128KB');
    const safeName=cleanFileName(fileName);
    const input={language:'Solidity',sources:{[safeName]:{content:source}},settings:{
      evmVersion:'london',optimizer:{enabled:true,runs:200},
      outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object','metadata']}}
    }};
    const output=JSON.parse(solc.compile(JSON.stringify(input),{import:path=>this.importFile(path)}));
    const messages=(output.errors||[]).map(item=>({severity:item.severity||'error',message:compilerText(item)}));
    const errors=messages.filter(item=>item.severity==='error');
    if(errors.length)throw Error(errors.map(item=>item.message).join('\n').slice(0,24000));
    const artifacts=[];
    for(const [sourceName,contracts] of Object.entries(output.contracts||{})){
      if(sourceName!==safeName)continue;
      for(const [name,item] of Object.entries(contracts||{})){
        const bytecode=item.evm?.bytecode?.object||'';
        const runtimeBytecode=item.evm?.deployedBytecode?.object||'';
        if(!bytecode)continue;
        if(bytecode.length/2>MAX_BYTECODE_BYTES)throw Error(`合约 ${name} 的部署字节码超过48KB限制`);
        if(runtimeBytecode.length/2>MAX_RUNTIME_BYTES)throw Error(`合约 ${name} 的运行时代码超过EVM 24KB限制`);
        artifacts.push({
          name,sourceName,abi:item.abi||[],bytecode:'0x'+bytecode,
          bytecodeBytes:bytecode.length/2,runtimeBytes:runtimeBytecode.length/2,
          constructorInputs:(item.abi||[]).find(x=>x.type==='constructor')?.inputs||[]
        });
      }
    }
    if(!artifacts.length)throw Error('没有找到可以部署的具体合约；接口和抽象合约不能单独部署');
    this.prune();
    const buildId=randomUUID();
    const sourceHash='0x'+createHash('sha256').update(source).digest('hex');
    this.builds.set(buildId,{createdAt:Date.now(),sourceHash,source,fileName:safeName,artifacts});
    return {buildId,sourceHash,compilerVersion:solc.version(),evmVersion:'london',warnings:messages.filter(x=>x.severity!=='error'),artifacts};
  }

  compileTemplate(mode){
    const fixed=mode==='fixed';
    if(!fixed&&mode!=='managed')throw Error('代币发行模式无效');
    const fileName=fixed?'NiuFixedToken.sol':'NiuManagedToken.sol';
    const source=readFileSync(resolve(this.root,'contracts',fileName),'utf8');
    return this.compile(source,fileName);
  }

  artifact(buildId,contractName){
    this.prune();
    const build=this.builds.get(buildId);
    if(!build)throw Error('编译结果已过期，请重新编译');
    const artifact=build.artifacts.find(item=>item.name===contractName);
    if(!artifact)throw Error('编译结果中没有这个合约');
    return {build,artifact};
  }
}

export const ERC20_ABI=[
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'event Transfer(address indexed from,address indexed to,uint256 value)'
];
