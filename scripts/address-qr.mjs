// SPDX-License-Identifier: GPL-3.0-or-later
import QRCode from 'qrcode';

export function validReceiveAddress(address){
  return typeof address==='string'&&/^0x[0-9a-fA-F]{40}$/.test(address);
}

export async function addressQrSvg(address){
  if(!validReceiveAddress(address))throw Error('收款地址格式不正确');
  return QRCode.toString(address,{type:'svg',errorCorrectionLevel:'M',margin:2,width:240,
    color:{dark:'#1F1F1D',light:'#FFFFFF'}});
}
