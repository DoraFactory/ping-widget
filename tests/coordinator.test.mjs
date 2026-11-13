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
 b.onResolve({filter:/.*/},args=>args.kind==='entry-point'?undefined:{path:args.path,namespace:'fixture'});
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='./Wallet'?`export const createWallet=(name,arg,registry)=>globalThis.testWallet;`:args.path==='../utils/http'?`export const post=(...args)=>globalThis.testPost(...args);`:noopModule,loader:'js'}));
}}]});
const {UniClient}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const tx=()=>({chainId:'vota-testnet',messages:[],fee:{gas:'1'}});
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
 delete window.doraPqcTransactions;await assert.rejects(new UniClient('Keplr',{}).execute('endpoint',tx()),/502/);assert.equal(posts,1);
});
test('both user-facing Dora transaction paths use execute; no direct sign path remains',async()=>{
 for(const path of ['lib/components/TxDialog/index.vue','lib/components/TokenConvert/index.vue']){
  const source=await readFile(path,'utf8');assert.match(source,/client\.execute\(/);assert.doesNotMatch(source,/client\.sign\(/);
 }
});
