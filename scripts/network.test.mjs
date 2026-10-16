import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateNetwork,p2pConfig,syncPending,validNodeKey} from './network.mjs';
// secp256k1 base point G, a genuine uncompressed public key (X||Y)
const NODE_KEY='79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
  +'483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8';
const profile={version:1,chainId:26261017,networkId:26261017,genesisHash:'0x'+'ab'.repeat(32),
  peers:['enode://'+NODE_KEY+'@192.168.1.20:30871'],allowPeerIPs:[],listenAddress:'127.0.0.1',coordinator:false,advertiseIP:null,restrictPeerIPs:true};
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
test('a syntactically valid but off-curve node key is refused before startup',()=>{
  assert.equal(validNodeKey(NODE_KEY),true);
  // Same length, same charset, but not a point on secp256k1: this is what a
  // mistyped enode looks like, and the node used to die on it at startup.
  assert.equal(validNodeKey('11'.repeat(64)),false);
  assert.equal(validNodeKey(NODE_KEY.slice(0,-1)+'0'),false);
  assert.throws(()=>validateNetwork({...profile,peers:['enode://'+'11'.repeat(64)+'@192.168.1.20:30871']}),
    /公钥无效/);
});
test('genesis zero-progress object does not deadlock the first miner',()=>{
  assert.equal(syncPending(false),false);
  assert.equal(syncPending({currentBlock:'0x0',highestBlock:'0x0'}),false);
  assert.equal(syncPending({currentBlock:'0x1',highestBlock:'0x2'}),true);
  assert.equal(syncPending({}),true);
});
