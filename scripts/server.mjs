import http from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {NiuLab,ROOT} from './lab.mjs';

const host='127.0.0.1',port=18790,origin=`http://${host}:${port}`;
const token=randomBytes(32).toString('hex');
const lab=new NiuLab({ports:[19145,19146],p2p:[30871,30872],auth:[19151,19152]});
let stopping=false,initializing=true,startupError=null;
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
async function body(req){req.setEncoding('utf8');let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>8192)throw Error('请求内容过长');}try{return JSON.parse(data||'{}');}catch{throw Error('请求格式无效');}}
function authorized(req){
  const provided=Buffer.from(req.headers['x-niu-token']||'');const expected=Buffer.from(token);
  return req.headers.origin===origin&&provided.length===expected.length&&timingSafeEqual(provided,expected);
}
const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
  if(req.headers.host!==`${host}:${port}`)return json(res,403,{error:'仅限本机地址访问'});
  if(req.headers['sec-fetch-site']&&!['same-origin','none'].includes(req.headers['sec-fetch-site']))return json(res,403,{error:'拒绝跨站访问钱包'});
  const url=new URL(req.url,origin);
  try{
    if(req.method==='GET'&&url.pathname==='/'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      return res.end(readFileSync(resolve(ROOT,'public/index.html'),'utf8').replace('__NIU_TOKEN__',token));
    }
    if(req.method==='GET'&&url.pathname==='/api/state'){
      if(initializing)return json(res,200,{initializing:true});
      if(startupError)return json(res,503,{error:startupError});
      return json(res,200,await lab.state());
    }
    if(req.method==='POST'){
      if(!authorized(req))return json(res,403,{error:'请求来源校验失败，请从本机控制台操作'});
      if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')return json(res,415,{error:'仅接受JSON请求'});
      if(url.pathname==='/api/shutdown'){
        if(initializing)return json(res,409,{error:'节点正在启动，请就绪后再关闭'});
        if(lab.busy)return json(res,409,{error:'交易仍在处理中，请等待确认后再关闭'});
        json(res,200,{message:'正在关闭节点，稍后页面将无法连接。'});setTimeout(shutdown,100);return;
      }
      if(initializing||startupError||stopping)return json(res,503,{error:'节点尚未就绪'});
      const data=await body(req);
      if(url.pathname==='/api/mine'){
        if(typeof data.enabled!=='boolean')return json(res,400,{error:'挖矿参数无效'});
        return json(res,200,await lab.mine(data.enabled));
      }
      if(url.pathname==='/api/transfer')return json(res,200,await lab.transfer(data.to,data.amount,data.from));
      if(url.pathname==='/api/unlock')return json(res,200,await lab.unlock(data.password));
      if(url.pathname==='/api/lock'){lab.lock();return json(res,200,{locked:true});}
      if(url.pathname==='/api/new-address')return json(res,200,await lab.newAddress(data.label));
      if(url.pathname==='/api/contact')return json(res,200,await lab.saveContact(data.address,data.label));
      if(url.pathname==='/api/deploy')return json(res,200,await lab.deploy(data.message));
      if(url.pathname==='/api/message')return json(res,200,await lab.update(data.message));
      if(url.pathname==='/api/backup-portable')return json(res,200,await lab.portableBackup(data.password));
    }
    json(res,404,{error:'页面不存在'});
  }catch(e){json(res,400,{error:e.shortMessage||e.message||'操作失败，请查看日志'});}
});
server.requestTimeout=15000;server.headersTimeout=10000;server.maxConnections=32;server.maxRequestsPerSocket=100;
async function shutdown(){
  if(stopping)return;stopping=true;
  await lab.close();server.close(()=>process.exit(lab.graceful?0:1));
  server.closeAllConnections();
}
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'控制台已启动或端口被占用，请打开现有页面。':e.message);process.exitCode=1;});
server.listen(port,host,async()=>{
  console.log(`牛链中文控制台：${origin}`);
  try{await lab.start();initializing=false;console.log('两个持久节点已就绪；挖矿默认关闭。');}
  catch(e){initializing=false;startupError=e.message;console.error(e.message);}
});
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
