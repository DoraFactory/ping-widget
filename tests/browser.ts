// Isolated-chain test entry only. Never included in the production widget entry.
import { DirectSecp256k1HdWallet, Registry } from '@cosmjs/proto-signing';
import { Secp256k1HdWallet } from '@cosmjs/amino';
import { defaultRegistryTypes, StargateClient } from '@cosmjs/stargate';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { KeplerWallet } from '../lib/wallet/wallets/KeplerWallet';
import { parseAccountNumber, parseSequence } from '../lib/utils/accountNumber';
import { TokenUnitConverter } from '../lib/utils/TokenUnitConverter';
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
(window as any).testNumbers = () => {
  const values = ['0','9007199254740991','9007199254740992','9223372036854775808','18446744073709551615'];
  for (const value of values) check(parseAccountNumber(value).toString() === value, value);
  for (const bad of [9007199254740992, -1, '', '1.1', '18446744073709551616', null]) {
    let rejected=false; try { parseAccountNumber(bad); } catch { rejected=true; }
    check(rejected, 'must reject '+bad);
  }
  const c=new TokenUnitConverter({peaka:{base:'peaka', display:'DORA', denom_units:[{denom:'peaka',exponent:0,aliases:[]},{denom:'DORA',exponent:18,aliases:[]}] } as any});
  const amount='1234567890123456789';const d=c.baseToUnit({denom:'peaka',amount},'DORA');
  check(d.amount==='1.234567890123456789','DORA precision');
  check(c.displayToBase('peaka',d).amount===amount,'DORA round trip');
  return {uint64Boundaries:values,unsafeValuesRejected:true,doraRoundTrip:true};
};
(window as any).setupSigner = async (mnemonic: string, mode='direct') => {
  const wallet=mode==='amino' ? await Secp256k1HdWallet.fromMnemonic(mnemonic,{prefix:'dora'}) : await DirectSecp256k1HdWallet.fromMnemonic(mnemonic,{prefix:'dora'});
  const [account]=await wallet.getAccounts();
  (window as any).keplr={enable:async()=>{}};
  (window as any).getOfflineSigner=()=>wallet;
  return account.address;
};
(window as any).testAdapter = async (mnemonic: string, mode: string, recipient: string) => {
  const address=await (window as any).setupSigner(mnemonic,mode);
  const client=await StargateClient.connect('http://127.0.0.1:26657');
  try {
    const account=await client.getAccount(address); if(!account) throw new Error('missing funded account');
    const id=parseAccountNumber(account.accountNumber);check(id>=2n**63n,'must use post-upgrade account');
    const wallet=(window as any).getOfflineSigner();let signedNumber='';
    const method=mode==='amino'?'signAmino':'signDirect';const original=wallet[method].bind(wallet);
    wallet[method]=async (sender: string, doc: any)=>{signedNumber=String(mode==='amino'?doc.account_number:doc.accountNumber);return original(sender,doc);};
    const adapter=new KeplerWallet({chainId:await client.getChainId()},new Registry(defaultRegistryTypes));
    const tx:any={chainId:await client.getChainId(),signerAddress:address,messages:[{typeUrl:'/cosmos.bank.v1beta1.MsgSend',value:{fromAddress:address,toAddress:recipient,amount:[{denom:'peaka',amount:'7'}]}}],fee:{amount:[{denom:'peaka',amount:'30000000000000000'}],gas:'3000000'},memo:'widget-uint64-test',signerData:{accountNumber:id,sequence:parseSequence(account.sequence),chainId:await client.getChainId()}};
    const raw=mode==='amino'?await adapter.signAmino(tx):await adapter.signDirect(tx);
    check(signedNumber===id.toString(),'sign document number changed');
    const result=await client.broadcastTx(TxRaw.encode(raw).finish(),45000,500);check(result.code===0,result.rawLog||'broadcast failure');
    return {mode,address,accountNumber:id.toString(),signDocNumber:signedNumber,hash:result.transactionHash,height:result.height,code:result.code};
  } finally { client.disconnect(); }
};
