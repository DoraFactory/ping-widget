import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';import {transform} from 'esbuild';import {ref,computed} from 'vue';
const source=readFileSync('lib/components/TxDialog/messages/Withdraw.vue','utf8').match(/<script lang="ts" setup>([\s\S]*?)<\/script>/)[1].replace(/^import.*\n/gm,'');
const {code}=await transform(source,{loader:'ts'});
test('single-validator reward button only claims that validator; claim-all preserves the complete list',async()=>{
 for(const selected of ['validator2',undefined]){
  let api;const ctx={ref,computed,defineProps:()=>({sender:'owner',endpoint:'node',params:JSON.stringify({validator_address:selected})}),getDelegateRewards:async()=>({rewards:[{validator_address:'validator1'},{validator_address:'validator2'}]}),defineExpose:x=>api=x};
  vm.runInNewContext(code,ctx);api.initial();await Promise.resolve();
  assert.deepEqual(Array.from(api.msgs.value,m=>m.value.validatorAddress),selected?['validator2']:['validator1','validator2']);
 }
});
