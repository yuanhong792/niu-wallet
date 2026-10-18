// Probe only the local wallet started by desktop QA; no valid mutation is sent.
import {request} from 'node:http';
const origin='http://127.0.0.1:18790',checks=[];
async function probe(name,path,options,status){
  const r=await new Promise((resolve,reject)=>{
    const req=request(new URL(origin+path),{method:options.method||'GET',headers:options.headers||{},timeout:10000},res=>{
      let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>resolve({status:res.statusCode,text}));
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(Error('HTTP probe timeout')));req.end(options.body);
  });
  const text=r.text;if(r.status!==status)throw Error(`${name}: expected ${status}, got ${r.status}`);
  checks.push(name);return text;
}
try{
  const home=await probe('localConnection','/',{},200),token=home.match(/name="niu-token" content="([a-f0-9]{64})"/)?.[1];
  if(!token)throw Error('missing session token');
  const script=await probe('javascriptAsset','/app.js',{},200);
  if(!script.includes("'use strict'"))throw Error('invalid javascript asset');
  await probe('stylesheetAsset','/app.css',{},200);
  await probe('logoAsset','/niu-gold.png',{},200);
  await probe('hostValidation','/',{headers:{host:'attacker.invalid'}},403);
  await probe('crossSiteFetchRejected','/',{headers:{'sec-fetch-site':'cross-site'}},403);
  await probe('missingTokenRejected','/api/mine',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{"enabled":false}'},403);
  const headers={origin,'x-niu-token':token,'content-type':'application/json'};
  await probe('wrongOriginRejected','/api/mine',{method:'POST',headers:{...headers,origin:'https://attacker.invalid'},body:'{"enabled":false}'},403);
  await probe('formContentTypeRejected','/api/mine',{method:'POST',headers:{...headers,'content-type':'text/plain'},body:'{"enabled":false}'},415);
  const sentinel='SECRET_SENTINEL_DO_NOT_ECHO';
  const text=await probe('malformedBodyRejected','/api/mine',{method:'POST',headers,body:'{"password":"'+sentinel+'",invalid'},400);
  if(text.includes(sentinel))throw Error('request secret echoed in error');checks.push('noSecretEcho');
  await probe('oversizedBodyRejected','/api/mine',{method:'POST',headers,body:JSON.stringify({enabled:false,padding:'x'.repeat(8192)})},400);
  console.log(JSON.stringify({status:'passed',checks}));
}catch(e){console.error(JSON.stringify({status:'failed',error:e.message,checks}));process.exitCode=1;}
