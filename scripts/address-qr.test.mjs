// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {addressQrSvg,validReceiveAddress} from './address-qr.mjs';

test('receive-address QR accepts a wallet address and renders safe SVG',async()=>{
  const address='0x3BAF753645cb73C2c477694e1A57d90A742D6284';
  assert.equal(validReceiveAddress(address),true);
  const svg=await addressQrSvg(address);
  assert.match(svg,/^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg,/viewBox="0 0 \d+ \d+"/);
  assert.doesNotMatch(svg,/<script|onload=/i);
});

test('receive-address QR refuses malformed input',async()=>{
  assert.equal(validReceiveAddress('not-an-address'),false);
  await assert.rejects(addressQrSvg('not-an-address'),/收款地址格式不正确/);
});
