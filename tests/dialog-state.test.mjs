import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import { ref, computed, watch, nextTick, reactive } from 'vue';

// Exercise the actual component script with Vue watchers and deterministic reads.
const file = readFileSync('lib/components/TxDialog/index.vue','utf8');
const source = file.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  .replace(/^import[\s\S]*?;\s*$/gm, '');
const resultModule=await transform(readFileSync('lib/utils/transactionResult.ts','utf8'),{loader:'ts',format:'esm'});
const {transactionResult}=await import('data:text/javascript;base64,'+Buffer.from(resultModule.code).toString('base64'));
const { code } = await transform(source, { loader:'ts', target:'es2022' });
function fixture(execute=async()=>{throw Error("Invalid request fields");}, reads={}) {
  const props = reactive({ type:'send', sender:'dora1test', endpoint:'test', params:'{}', registryName:'doravotatestnet' });
  const timers = new Map(), events = [], receipts = [], balances = []; let timerId=0;
  const ctx = vm.createContext({ transactionResult, ref, computed, watch, nextTick, onUnmounted(){},
    getAccount:async()=>({account:{account_number:'12',sequence:'0'}}),
    parseAccountNumber:Number,parseSequence:Number,readWallet:()=>({wallet:'Keplr'}),WalletName:{Keplr:'Keplr'},
    UniClient:class{async execute(...args){args[4]({title:'PQC approval',description:'Waiting'});return execute(...args);}},BroadcastRejectedError:class extends Error{},
    window:{}, defineProps:()=>props, defineEmits:()=> (...args)=>events.push(args),
    Delegate:{},Deposit:{},Redelegate:{},Send:{},Transfer:{},Unbond:{},Vote:{},Withdraw:{},WithdrawCommission:{},StoreCode:{},ExecuteContract:{},InstantiateContract:{},MigrateContract:{},UpdateAdmin:{},ClearAdmin:{},
    BroadcastMode:{SYNC:'sync'},
    getBalance:()=>new Promise(resolve=>balances.push(resolve)),
    getBalanceMetadata:async()=>({}),getIBCDenomMetadata:async()=>({}),
    getChainId:async()=> 'test-chain', getStakingParam:async()=>({params:{bond_denom:'peaka'}}),
    getTxByHash:()=>new Promise(resolve=>receipts.push(resolve)),
    ...reads,
    setTimeout:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),
  });
  vm.runInContext(code+'\n globalThis.api={loading,loadError,initData,open,view,hash,msg,error,pending,step,balance,chainId,feeDenom,showResult,sendTx,acceptReceipt,progress,msgBox,memo,sending};',ctx);
  const flush=async()=>{await nextTick();await nextTick();};
  const tick=()=>{const [id,fn]=timers.entries().next().value;timers.delete(id);fn();};
  return {props,api:ctx.api,events,receipts,balances,timers,flush,tick};
}
test('successful send -> delegate always opens a clean form, including a different validator',async()=>{
  const f=fixture();f.api.open.value=true;await f.flush();
  f.api.hash.value='A'.repeat(64);f.api.showResult('A'.repeat(64));f.tick();
  f.receipts[0]({tx_response:{txhash:'A'.repeat(64),height:'12',code:0}});await f.flush();
  assert.equal(f.api.view.value,'submitting');assert.match(f.api.msg.value,/confirmed: send/);
  f.props.type='delegate';f.props.params='{"validator_address":"validator1"}';await f.flush();
  assert.equal(f.api.view.value,'input');assert.equal(f.api.hash.value,'');assert.equal(f.api.msg.value,'');assert.equal(f.api.step.value,0);
  f.api.error.value='old error';f.props.params='{"validator_address":"validator2"}';await f.flush();
  assert.equal(f.api.error.value,'');assert.equal(f.api.view.value,'input');
});
test('old receipt and balance responses cannot overwrite a new action or account',async()=>{
  const f=fixture();f.api.open.value=true;await f.flush();
  f.api.hash.value='B'.repeat(64);f.api.showResult('B'.repeat(64));f.tick();
  f.props.type='delegate';f.props.sender='dora1other';await f.flush();
  f.receipts[0]({tx_response:{txhash:'B'.repeat(64),height:'12',code:0}});
  f.balances[0]({balances:[{denom:'stale',amount:'9'}]});await f.flush();
  assert.equal(f.api.msg.value,'');assert.equal(f.api.hash.value,'');assert.equal(f.api.view.value,'input');
  assert.equal(f.api.balance.value.length,0);assert.equal(f.events.length,0);assert.equal(f.timers.size,0);
});
test('closing cancels pending receipt timer and reopening the same action clears errors/results',async()=>{
  const f=fixture();f.api.open.value=true;await f.flush();
  f.api.hash.value='B'.repeat(64);f.api.showResult('B'.repeat(64));assert.equal(f.timers.size,1);
  f.api.open.value=false;await f.flush();assert.equal(f.timers.size,0);
  f.api.open.value=true;await f.flush();
  assert.equal(f.api.view.value,'input');assert.equal(f.api.hash.value,'');assert.equal(f.api.pending.value,false);
});

test('included receipt finishes in the same dialog without adding a receipt timer',async()=>{
  const f=fixture();f.api.open.value=true;await f.flush();
  f.api.view.value='processing';f.api.acceptReceipt({txhash:'C'.repeat(64),height:'123',code:0},'C'.repeat(64),'delegate');
  assert.equal(f.api.view.value,'submitting');assert.equal(f.api.pending.value,false);
  assert.match(f.api.msg.value,/confirmed: delegate/);assert.equal(f.timers.size,0);
});
test('unconfirmed or mismatched receipts cannot show a successful result',async()=>{
  const f=fixture();f.api.open.value=true;await f.flush();
  for(const response of [{txhash:'C'.repeat(64),height:'0',code:0},{txhash:'D'.repeat(64),height:'12',code:0}])
    assert.throws(()=>f.api.acceptReceipt(response,'C'.repeat(64),'delegate'),/not confirmed|mismatch/);
  assert.equal(f.events.length,0);assert.equal(f.api.msg.value,'');
  f.api.acceptReceipt({txhash:'C'.repeat(64),height:'12',code:5,raw_log:'out of gas'},'C'.repeat(64),'delegate');
  assert.equal(f.api.pending.value,false);assert.equal(f.api.error.value,'out of gas');assert.equal(f.events.length,0);
});

test('signer rejection preserves the mounted form, selected validator, amount and memo for retry',async()=>{
  // Keep the real message component mounted during progress, unlike the prior v-if branch.
  assert.match(file,/<div v-if="open" v-show="view === 'input'">/);
  const f=fixture();f.api.open.value=true;await f.flush();
  const form={msgs:[{typeUrl:'/cosmos.staking.v1beta1.MsgDelegate',value:{validatorAddress:'validator1',amount:{denom:'peaka',amount:'1000'}}}],isValid:{ok:true}};
  f.api.msgBox.value=form;f.api.memo.value='my memo';
  await f.api.sendTx();await f.flush();
  assert.equal(f.api.view.value,'input');assert.equal(f.api.sending.value,false);assert.match(f.api.error.value,/Invalid request fields/);
  assert.deepEqual(f.api.msgBox.value.msgs,form.msgs);assert.equal(f.api.memo.value,'my memo');
  assert.equal(f.api.hash.value,'');assert.equal(f.timers.size,0);
});


test('failed initialization stays blocked and retry clears the failure after all reads finish', async()=>{
  let fail=true;
  const f=fixture(undefined, {getBalance:async()=>({balances:[]}), getChainId:async()=>{
    if(fail) throw Error('Network request timed out. Please retry.');
    return 'test-chain';
  }});
  f.api.open.value=true; await f.flush();
  await f.api.initData();
  assert.equal(f.api.loading.value,false);
  assert.match(f.api.loadError.value,/timed out/);
  assert.equal(f.api.chainId.value,'');
  fail=false; await f.api.initData();
  assert.equal(f.api.loadError.value,'');
  assert.equal(f.api.chainId.value,'test-chain');
  assert.equal(f.api.loading.value,false);
});
test('form preparation failure is reported and cannot escape as an unhandled rejection', async()=>{
  const f=fixture(undefined,{getBalance:async()=>({balances:[]})});
  f.api.open.value=true; await f.flush();
  f.api.msgBox.value={initial:async()=>{throw Error('Validator list unavailable');}};
  await f.api.initData();
  assert.match(f.api.loadError.value,/Validator list unavailable/);
  assert.equal(f.api.loading.value,false);
});

async function delegateFixture(reads={}) {
  let executions=0;
  const f=fixture(async()=>{executions++;throw Error('wallet boundary');},reads);
  f.props.type='delegate';
  f.props.params=JSON.stringify({form_context:{owner:'dora1test',endpoint:'test',chainId:'test-chain',balances:[{denom:'peaka',amount:'999'}]},staking_options:{params:{bond_denom:'peaka'}}});
  f.api.open.value=true;await f.flush();await f.api.initData();
  f.api.msgBox.value={isValid:{ok:true},msgs:[{typeUrl:'/cosmos.staking.v1beta1.MsgDelegate',value:{amount:{denom:'peaka',amount:'10'},validatorAddress:'chosen'}}]};
  return {...f,executions:()=>executions};
}
test('delegate opens from snapshots without any balance or network identity request',async()=>{
 let reads=0;
 const f=await delegateFixture({getBalance:async()=>{reads++;throw Error('offline');},getChainId:async()=>{reads++;throw Error('offline');}});
 assert.equal(reads,0);assert.equal(f.api.loading.value,false);assert.equal(f.api.loadError.value,'');
 assert.equal(f.api.balance.value[0].amount,'999');
});
test('submit refresh failure preserves form and reports all failures without calling wallet',async()=>{
 const f=await delegateFixture({getBalance:async()=>{throw Error('balance timeout');},getChainId:async()=>{throw Error('network timeout');}});
 const form=f.api.msgBox.value;f.api.memo.value='keep';
 await f.api.sendTx();
 assert.equal(f.executions(),0);assert.match(f.api.error.value,/network timeout.*balance timeout/);
 assert.equal(f.api.view.value,'input');assert.equal(f.api.sending.value,false);
 assert.equal(f.api.msgBox.value,form);assert.equal(f.api.memo.value,'keep');
});
test('submit rejects wrong network and insufficient fresh balance before the wallet',async()=>{
 for(const [id,amount,expected] of [['other','99',/Network mismatch/],['test-chain','1',/Insufficient balance/]]){
  const f=await delegateFixture({getBalance:async()=>({balances:[{denom:'peaka',amount}]}),getChainId:async()=>id});
  await f.api.sendTx();assert.equal(f.executions(),0);assert.match(f.api.error.value,expected);
 }
});
test('valid fresh state reaches existing signing coordinator, never signs from the cached balance',async()=>{
 const f=await delegateFixture({getBalance:async()=>({balances:[{denom:'peaka',amount:'20'}]})});
 await f.api.sendTx();assert.equal(f.executions(),1);assert.equal(f.api.balance.value[0].amount,'20');
 assert.match(f.api.error.value,/wallet boundary/);
});
test('closing during submit checks prevents wallet invocation',async()=>{
 let resolve;const f=await delegateFixture({getBalance:()=>new Promise(r=>resolve=r)});
 const pending=f.api.sendTx();f.api.open.value=false;await f.flush();
 resolve({balances:[{denom:'peaka',amount:'100'}]});await pending;
 assert.equal(f.executions(),0);
});

test('receipt UI rejects missing, malformed, unsafe and out-of-range heights and codes',async()=>{
 const f=fixture();f.api.open.value=true;await f.flush();const hash='E'.repeat(64);
 for(const height of [undefined,null,'bad','0','-1','1.5','1e3','9223372036854775808',9007199254740992])
  assert.throws(()=>f.api.acceptReceipt({txhash:hash,height,code:0},hash,'delegate'));
 for(const code of [undefined,null,'',false,'0.0',-1,4294967296])
  assert.throws(()=>f.api.acceptReceipt({txhash:hash,height:'42',code},hash,'delegate'));
 assert.equal(f.events.length,0);assert.equal(f.api.step.value,0);
});
test('broadcast callback binds the displayed result to local hash; mismatch remains pending',async()=>{
 const hash='E'.repeat(64);
 const f=fixture(async(...args)=>{args[5].onBroadcast(hash);return {tx_response:{txhash:'F'.repeat(64),height:'42',code:0}};});
 f.api.open.value=true;await f.flush();f.api.chainId.value='test-chain';f.api.feeDenom.value='peaka';f.api.msgBox.value={isValid:{ok:true},msgs:[]};
 await f.api.sendTx();assert.equal(f.api.hash.value,hash);assert.equal(f.api.pending.value,true);assert.equal(f.api.step.value,0);assert.equal(f.events.length,0);
});
test('closing the dialog invalidates the lifecycle guard given to the coordinator',async()=>{
 let lifecycle,finish;const gate=new Promise(r=>finish=r);
 const f=fixture(async(...args)=>{lifecycle=args[5];await gate;lifecycle.assertActive();});
 f.api.open.value=true;await f.flush();f.api.chainId.value='test-chain';f.api.feeDenom.value='peaka';f.api.msgBox.value={isValid:{ok:true},msgs:[]};
 const pending=f.api.sendTx();await f.flush();f.api.open.value=false;await f.flush();
 assert.throws(()=>lifecycle.assertActive(),/cancelled/);finish();await pending;assert.equal(f.events.length,0);
});
