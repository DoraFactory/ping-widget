// Compile the actual UniClient with deterministic wallet/network dependencies.
// No browser wallet or live broadcast is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {build}=require('esbuild');
const noopModule=`export const defaultRegistryTypes=[],wasmTypes=[];export class Registry{};export const encodePubkey=()=>{},makeAuthInfoBytes=()=>{},makeSignDoc=()=>{},encodeSecp256k1Pubkey=()=>{};export const SignMode={};export const Any={};export const AuthInfo={};export const TxRaw={encode:raw=>({finish:()=>new Uint8Array([raw.marker||1])}),fromPartial:x=>x};export const toBase64=()=>'',fromBase64=()=>{},fromBech32=()=>{},toHex=()=> 'A'.repeat(64),sha256=x=>x;export const BroadcastMode={SYNC:'BROADCAST_MODE_SYNC'};`;
const compiled=await build({entryPoints:['lib/wallet/UniClient.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'test-boundaries',setup(b){
 b.onResolve({filter:/.*/},args=>args.kind==='entry-point'||args.path.includes('transactionResult')?undefined:{path:args.path,namespace:'fixture'});
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='./Wallet'?`export const createWallet=(name,arg,registry)=>globalThis.testWallet;`:args.path==='../utils/http'?`export const post=(...args)=>globalThis.testPost(...args);export const getTxByHash=(...args)=>globalThis.testGet(...args);`:noopModule,loader:'js'}));
}}]});
const {UniClient}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const map=new Map();
globalThis.localStorage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_key,_options,fn)=>fn({})}}});
const tx=()=>({signerAddress:'owner',chainId:'vota-testnet',messages:[],fee:{gas:'1'}});
test('actual client preserves wallet name and dispatches protected routing without classic signing',async()=>{
 globalThis.window={};let signs=0,posts=0;
 globalThis.testWallet={sign:async()=>{signs++;}};globalThis.testPost=async()=>{posts++;};
 window.doraPqcTransactions={execute:async(ctx,classic)=>{assert.equal(ctx.wallet,'Keplr');assert.equal(ctx.transaction.chainId,'vota-testnet');return 'handled';}};
 assert.equal(await new UniClient('Keplr',{}).execute('endpoint',tx()),'handled');assert.equal(signs,0);assert.equal(posts,0);
});
test('classic preparation and guards occur in order; original request is not mutated',async()=>{
 const order=[];globalThis.testWallet={sign:async t=>{order.push('sign');assert.equal(t.fee.gas,'2');return {marker:1};}};
 globalThis.testPost=async()=>{order.push('broadcast');return {tx_response:{code:0,txhash:'A'.repeat(64)}};};
 window.doraPqcTransactions={execute:async(_ctx,classic)=>classic(async stage=>{order.push('guard-'+stage);})};
 const original=tx();await new UniClient('Keplr',{}).execute('endpoint',original,undefined,async t=>{order.push('prepare');t.fee.gas='2';});
 assert.deepEqual(order,['prepare','guard-sign','sign','guard-broadcast','broadcast']);assert.equal(original.fee.gas,'1');
});
test('guard failure never broadcasts and unknown transport errors propagate once',async()=>{
 let posts=0;globalThis.testWallet={sign:async()=>({marker:1})};globalThis.testPost=async()=>{posts++;throw Error('502');};
 window.doraPqcTransactions={execute:async(_ctx,classic)=>classic(async stage=>{if(stage==='broadcast')throw Error('policy changed');})};
 await assert.rejects(new UniClient('Keplr',{}).execute('endpoint',tx()),/policy changed/);assert.equal(posts,0);
 delete window.doraPqcTransactions;await assert.rejects(new UniClient('Keplr',{}).execute('endpoint',tx()),/outcome unknown/);assert.equal(posts,1);
});
test('both user-facing Dora transaction paths use execute; no direct sign path remains',async()=>{
 for(const path of ['lib/components/TxDialog/index.vue','lib/components/TokenConvert/index.vue']){
  const source=await readFile(path,'utf8');assert.match(source,/client\.execute\(/);assert.doesNotMatch(source,/client\.sign\(/);
 }
});

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('standalone broadcast records the local hash before transport and blocks retry after reload',async()=>{
 map.clear();window={};let posts=0,signs=0;
 globalThis.testWallet={sign:async()=>{signs++;return {marker:1};}};
 globalThis.testPost=async()=>{posts++;assert.equal(JSON.parse([...map.values()][0]).txhash,'A'.repeat(64));throw Error('timeout');};
 globalThis.testGet=async()=>{throw Error('not found');};
 await assert.rejects(new UniClient('Keplr',{}).execute('endpoint',tx()),e=>e.txhash==='A'.repeat(64));
 await assert.rejects(new UniClient('Keplr',{}).execute('endpoint',tx()),e=>e.txhash==='A'.repeat(64));
 assert.equal(signs,1);assert.equal(posts,1);assert.equal(map.size,1);
});
test('wrong hash or malformed rejection cannot clear the pending journal',async()=>{
 for(const response of [{txhash:'B'.repeat(64),code:0,height:'42'}, {txhash:'A'.repeat(64),code:null}, {txhash:'B'.repeat(64),code:11}]){
  map.clear();window={};globalThis.testWallet={sign:async()=>({marker:1})};globalThis.testPost=async()=>({tx_response:response});
  await assert.rejects(new UniClient('Keplr',{}).execute('endpoint',tx()),e=>e.txhash==='A'.repeat(64));assert.equal(map.size,1);
 }
});
test('cancellation during preparation or wallet approval stops subsequent signing/broadcast',async()=>{
 for(const stage of ['prepare','sign']){
  map.clear();window={};let active=true,signs=0,posts=0;const gate=deferred();
  globalThis.testWallet={sign:async()=>{signs++;if(stage==='sign')await gate.promise;return {marker:1};}};
  globalThis.testPost=async()=>{posts++;};
  const pending=new UniClient('Keplr',{}).execute('endpoint',tx(),undefined,async()=>{if(stage==='prepare')await gate.promise;},undefined,{assertActive(){if(!active)throw Error('cancelled');}});
  await new Promise(r=>setImmediate(r));active=false;gate.resolve();
  await assert.rejects(pending,/cancelled/);assert.equal(signs,stage==='prepare'?0:1);assert.equal(posts,0);assert.equal(map.size,0);
 }
});
test('cancellation after broadcast preserves the hash for reconciliation',async()=>{
 map.clear();window={};const gate=deferred();let active=true;
 globalThis.testWallet={sign:async()=>({marker:1})};globalThis.testPost=async()=>{await gate.promise;throw Error('timeout');};
 const pending=new UniClient('Keplr',{}).execute('endpoint',tx(),undefined,undefined,undefined,{assertActive(){if(!active)throw Error('cancelled');}});
 await new Promise(r=>setImmediate(r));active=false;gate.resolve();
 await assert.rejects(pending,e=>e.txhash==='A'.repeat(64));assert.equal(map.size,1);
});
test('a matched included receipt resolves the old operation without creating another transaction',async()=>{
 map.clear();window={};let signs=0;
 globalThis.testWallet={sign:async()=>{signs++;return {marker:1};}};
 globalThis.testPost=async()=>{throw Error('timeout');};
 await assert.rejects(new UniClient('Keplr',{}).execute('endpoint',tx()));
 for(const height of [undefined,'invalid','0','-1','1.5','9223372036854775808']){
  globalThis.testGet=async()=>({tx_response:{txhash:'A'.repeat(64),code:0,height}});
  await assert.rejects(new UniClient('Keplr',{}).execute('endpoint',tx()),/unknown/);assert.equal(signs,1);
 }
 globalThis.testGet=async()=>({tx_response:{txhash:'A'.repeat(64),code:0,height:'42'}});
 globalThis.testPost=async()=>({tx_response:{txhash:'A'.repeat(64),code:11}});
 const result=await new UniClient('Keplr',{}).execute('endpoint',tx());assert.equal(result.tx_response.height,'42');assert.equal(signs,1);assert.equal(map.size,0);
});

test('cancellation after host reservation reports that no broadcast was attempted',async()=>{
 map.clear();let active=true,posts=0;globalThis.testWallet={sign:async()=>({marker:1})};globalThis.testPost=async()=>{posts++;};
 window={doraPqcTransactions:{execute:async(_context,classic)=>classic(async stage=>{if(stage==='broadcast')active=false;})}};
 await assert.rejects(new UniClient('Keplr',{}).execute('endpoint',tx(),undefined,undefined,undefined,{assertActive(){if(!active)throw Error('cancelled');}}),e=>e.code==='BROADCAST_NOT_ATTEMPTED');
 assert.equal(posts,0);assert.equal(map.size,0);
});
