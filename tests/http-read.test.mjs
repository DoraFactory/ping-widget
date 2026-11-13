import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {transform} from 'esbuild';
const source=readFileSync('lib/utils/http.ts','utf8').replace(/^import .*$/gm,'').replace(/export /g,'');
const {code}=await transform(source,{loader:'ts'});
function fixture(fetch){const ctx=vm.createContext({fetch,AbortSignal});vm.runInContext(code+';globalThis.api={get,getChainId}',ctx);return ctx.api;}
test('read timeout reports an actionable error instead of AbortError',async()=>{
 const api=fixture(async()=>{const err=Error('Aborted.');err.name='AbortError';throw err;});
 await assert.rejects(api.getChainId('test'),/Network request timed out. Please retry/);
});
test('HTTP error is rejected before interpreting error JSON as account data',async()=>{
 const api=fixture(async()=>({ok:false,status:502,json(){throw Error('must not parse');}}));
 await assert.rejects(api.get('test'),/502/);
});
test('network identity is validated and read from node info',async()=>{
 const api=fixture(async()=>({ok:true,json:async()=>({default_node_info:{network:'vota-testnet'}})}));
 assert.equal(await api.getChainId('test'),'vota-testnet');
 await assert.rejects(fixture(async()=>({ok:true,json:async()=>({})})).getChainId('test'),/identity unavailable/);
});
test('concurrent identical reads share one request, but subsequent reads remain fresh',async()=>{
 let calls=0,resolve;
 const api=fixture(()=>{calls++;return new Promise(r=>resolve=r);});
 const a=api.get('same'),b=api.get('same');assert.equal(calls,1);
 resolve({ok:true,json:async()=>({value:1})});await Promise.all([a,b]);
 const c=api.get('same');assert.equal(calls,2);
 resolve({ok:true,json:async()=>({value:2})});assert.equal((await c).value,2);
});
