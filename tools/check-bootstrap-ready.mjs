// Checks whether this machine can act as a bootstrap node: it reports if the
// machine sits behind NAT and whether a public IPv4 is visible. Run locally;
// it only prints what is needed to configure the node.
import {execFileSync} from 'node:child_process';
import os from 'node:os';

const ports=30471;
function sh(cmd){try{return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',cmd],{encoding:'utf8',timeout:25000}).trim();}catch{return '';}}

console.log('=== 本机网络概况 ===');
for(const [name,list] of Object.entries(os.networkInterfaces()))
  for(const ni of list||[])
    if(ni.family==='IPv4'&&!ni.internal)
      console.log(`网卡 ${name}: ${ni.address}  MAC=${ni.mac}`);

console.log('\n=== 公网出口 IP（经 NAT 映射后的地址）===');
let publicIp='';
try{
  const r=await fetch('https://api.ipify.org?format=json',{signal:AbortSignal.timeout(15000)});
  const j=await r.json();publicIp=j.ip;
}catch{try{
  const r=await fetch('https://ifconfig.me/ip',{signal:AbortSignal.timeout(15000)});
  publicIp=(await r.text()).trim();
}catch{}}
console.log(publicIp||'（未取到，可能是无外网）');

console.log('\n=== 是否处于 NAT 之后 ===');
const lanDetail=sh('Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway -ne $null} | ForEach-Object { $_.InterfaceAlias + " = " + $_.IPv4DefaultGateway.NextHop }');
console.log(lanDetail||'（无法读取）');

console.log('\n=== 默认网关类型判断 ===');
const gwList=sh(`Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway -ne $null} | ForEach-Object { $_.IPv4DefaultGateway.NextHop }`).split(/\r?\n/).filter(Boolean);
for(const gw of gwList){
  const octet=Number(gw.split('.')[0]);
  let kind='公网地址（路由器直接持有公网IP）';
  if(octet===10)kind='RFC1918 私有地址（100.64.0.0/10 或 10/8，多级 NAT）';
  else if(octet===172&&Number(gw.split('.')[1])>=16&&Number(gw.split('.')[1])<=31)kind='RFC1918 私有地址（172.16/12，多级 NAT）';
  else if(octet===192&&gw.split('.')[1]==='168')kind='RFC1918 私有地址（192.168/16，家用路由器）';
  else if(octet===100&&Number(gw.split('.')[1])>=64&&Number(gw.split('.')[1])<=127)kind='运营商级 NAT（100.64/10）';
  console.log(`网关 ${gw}: ${kind}`);
}

console.log('\n=== 端口状态 ===');
const listening=sh(`Get-NetTCPConnection -State Listen -LocalPort ${ports} -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count`);
console.log(`本机 TCP ${ports} 正在监听: ${listening||'0'}`);

const firewall=sh(`(Get-NetFirewallRule -Enabled True -Direction Inbound -ErrorAction SilentlyContinue | Where-Object {
  ($_ | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue).LocalPort -eq '${ports}'
} | Measure-Object).Count`);
console.log(`防火墙入站规则命中 ${ports}: ${firewall||'0'}`);

console.log('\n=== 结论提示 ===');
const lanIps=[];
for(const list of Object.values(os.networkInterfaces()))
  for(const ni of list||[])
    if(ni.family==='IPv4'&&!ni.internal)lanIps.push(ni.address);
const hasPublicOnNic=lanIps.some(ip=>ip===publicIp);
if(hasPublicOnNic){
  console.log('本机网卡直接持有公网 IP，无需端口转发即可对外提供服务。');
  console.log(`network-config.json 中 advertiseIP 填 ${publicIp}。`);
}else{
  console.log('本机只有内网地址，需要在路由器上做端口转发：外部 30871/TCP -> 本机 '+(lanIps[0]||'内网IP')+':30871。');
  console.log(`转发完成后 advertiseIP 填 ${publicIp||'你的公网IP'}。`);
  console.log('若公网 IP 每次重拨都会变化，配置需要相应更新并通知使用者。');
}
console.log('完成转发或确认直连后，重新运行本脚本核对，并按 docs/引导节点部署.md 验收。');
