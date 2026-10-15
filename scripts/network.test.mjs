import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateNetwork,p2pConfig,syncPending} from './network.mjs';
const profile={version:1,chainId:26261017,networkId:26261017,genesisHash:'0x'+'ab'.repeat(32),
  peers:['enode://'+'11'.repeat(64)+'@192.168.1.20:30871'],allowPeerIPs:[],listenAddress:'127.0.0.1',coordinator:false,advertiseIP:null,restrictPeerIPs:true};
test('friend profile rejects unrelated networks and malformed peer input',()=>{
  assert.equal(validateNetwork(profile).peerIPs[0],'192.168.1.20');
  assert.match(p2pConfig(profile,30871),/StaticNodes/);
  assert.equal(validateNetwork({...profile,peers:[profile.peers[0]+'?discport=0']}).peers.length,1);
  assert.throws(()=>validateNetwork({...profile,chainId:1}));
  assert.throws(()=>validateNetwork({...profile,peers:[]}));
  assert.throws(()=>validateNetwork({...profile,peers:[profile.peers[0]+'\n[Node]']}));
  assert.throws(()=>validateNetwork({...profile,allowPeerIPs:['0.0.0.0/0']}));
  assert.throws(()=>validateNetwork({...profile,advertiseIP:'not-an-ip'}));
});
test('genesis zero-progress object does not deadlock the first miner',()=>{
  assert.equal(syncPending(false),false);
  assert.equal(syncPending({currentBlock:'0x0',highestBlock:'0x0'}),false);
  assert.equal(syncPending({currentBlock:'0x1',highestBlock:'0x2'}),true);
  assert.equal(syncPending({}),true);
});
