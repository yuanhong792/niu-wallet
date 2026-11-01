export const NETWORKS=Object.freeze({
  ethereum:{id:'ethereum',name:'Ethereum 主网',kind:'evm',chainId:1,test:false,rpc:'https://ethereum-rpc.publicnode.com',explorer:'https://etherscan.io/tx/',tokens:{ETH:{decimals:18},USDT:{decimals:6,address:'0xdac17f958d2ee523a2206206994597c13d831ec7'},USDC:{decimals:6,address:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'}}},
  bitcoin:{id:'bitcoin',name:'Bitcoin 主网',kind:'btc',test:false,api:'https://blockstream.info/api',explorer:'https://blockstream.info/tx/',tokens:{BTC:{decimals:8}}},
  dogecoin:{id:'dogecoin',name:'Dogecoin 主网',kind:'doge',test:false,api:'https://api.blockcypher.com/v1/doge/main',explorer:'https://blockchair.com/dogecoin/transaction/',tokens:{DOGE:{decimals:8}}},
  sepolia:{id:'sepolia',name:'Sepolia 测试网',kind:'evm',chainId:11155111,test:true,rpc:'https://ethereum-sepolia-rpc.publicnode.com',explorer:'https://sepolia.etherscan.io/tx/',tokens:{ETH:{decimals:18},USDC:{decimals:6,address:'0x1c7d4b196cb0c7b01d743fbc6116a902379c7238'}}},
  bitcoinTest:{id:'bitcoinTest',name:'Bitcoin Testnet 测试网',kind:'btc',test:true,api:'https://blockstream.info/testnet/api',explorer:'https://blockstream.info/testnet/tx/',tokens:{BTC:{decimals:8}}}
});
// Dogecoin uses its own P2PKH version bytes; bitcoinjs-lib ships no preset for it.
// bech32 is never used (Dogecoin has no SegWit), it only keeps the library happy.
export const DOGE_CHAIN=Object.freeze({
  messagePrefix:'\x19Dogecoin Signed Message:\n',
  bech32:'doge',
  bip32:{public:0x02facafd,private:0x02fac398},
  pubKeyHash:0x1e,
  scriptHash:0x16,
  wif:0x9e
});
export function network(id){const n=NETWORKS[id];if(!n)throw Error('不支持的网络');return n;}
export function quantity(text,decimals){if(typeof text!=='string'||!new RegExp('^(0|[1-9][0-9]{0,20})(\\.[0-9]{1,'+decimals+'})?$').test(text))throw Error('金额格式或小数位数无效');const [a,b='']=text.split('.');const n=BigInt(a)*10n**BigInt(decimals)+BigInt(b.padEnd(decimals,'0'));if(n<=0n)throw Error('金额必须大于0');return n;}
