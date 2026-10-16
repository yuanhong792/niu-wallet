// Administrative RPC is sent through a local OS pipe, never the HTTP listener.
import {JsonRpcProvider,IpcSocketProvider} from 'ethers';
// ethers 6.17 IPC emits a socket-close event that its base provider does not
// recognize. Handle that lifecycle event explicitly instead of an unhandled
// rejected promise during normal node shutdown.
class LocalIpcProvider extends IpcSocketProvider {
  async emit(event,...args){if(event==='close')return false;return super.emit(event,...args);}
}
export class NiuProvider extends JsonRpcProvider {
  constructor(port,pipe){
    super(`http://127.0.0.1:${port}`,undefined,{cacheTimeout:-1});
    this.control=new LocalIpcProvider(pipe,undefined,{cacheTimeout:-1});
    this.control.socket.on('error',()=>{this.controlFailure=true;});
    this.control.socket.on('close',()=>{this.controlFailure=true;});
  }
  async send(method,params){
    if(method.startsWith('admin_')||method.startsWith('miner_')||method.startsWith('debug_')){
      if(this.controlFailure)throw Error('本机节点IPC连接失败');
      let timer;
      try{return await Promise.race([this.control.send(method,params),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('本机节点控制超时')),15000);})]);}
      finally{clearTimeout(timer);}
    }
    return super.send(method,params);
  }
  destroy(){this.control.destroy();super.destroy();}
}
