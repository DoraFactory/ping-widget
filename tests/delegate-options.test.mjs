import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {transform} from 'esbuild';
import {ref,computed} from 'vue';
const source=readFileSync('lib/components/TxDialog/messages/Delegate.vue','utf8').match(/<script lang="ts" setup>([\s\S]*?)<\/script>/)[1].replace(/^import[\s\S]*?;\s*$/gm,'');
const {code}=await transform(source,{loader:'ts'});
test('existing Explorer options initialize delegate without any network read',async()=>{
 const props={params:JSON.stringify({validator_address:'chosen',staking_options:{params:{bond_denom:'peaka'},validators:[{operator_address:'chosen'}]}})};
 let api;const ctx=vm.createContext({ref,computed,defineProps:()=>props,defineExpose:a=>api=a,getStakingParam:()=>{throw Error('unexpected read');},getActiveValidators:()=>{throw Error('unexpected read');}});
 vm.runInContext(code,ctx);await api.initial();
 assert.equal(vm.runInContext('stakingDenom.value',ctx),'peaka');
 assert.equal(vm.runInContext('activeValidators.value.length',ctx),1);
 assert.equal(vm.runInContext('validator.value',ctx),'chosen');
});
