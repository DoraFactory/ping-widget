<script setup lang="ts">
import { parseAccountNumber, parseSequence } from "../../utils/accountNumber";
import { ref, computed, watch, nextTick, onUnmounted } from 'vue';
import {
    getAccount,
    getBalance,
    getBalanceMetadata,
    getIBCDenomMetadata,
    getChainId,
    getStakingParam,
    getTxByHash,
} from '../../utils/http';
import { BroadcastMode, Coin, CoinMetadata } from '../../utils/type';
import { WalletName, readWallet } from '../../../lib/wallet/Wallet';
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { UniClient, BroadcastRejectedError } from '../../../lib/wallet/UniClient';

// cosmos sdk messages
import Delegate from './messages/Delegate.vue';
import Deposit from './messages/Deposit.vue';
import Redelegate from './messages/Redelegate.vue';
import Send from './messages/Send.vue';
import Transfer from './messages/Transfer.vue';
import Unbond from './messages/Unbond.vue';
import Vote from './messages/Vote.vue';
import Withdraw from './messages/Withdraw.vue';
import WithdrawCommission from './messages/WithdrawCommission.vue';

// wasm msgs
import StoreCode from './wasm/StoreCode.vue';
import ExecuteContract from './wasm/ExecuteContract.vue';
import InstantiateContract from './wasm/InstantiateContract.vue';
import ChainRegistryClient from '@ping-pub/chain-registry-client';
import MigrateContract from './wasm/MigrateContract.vue';
import UpdateAdmin from './wasm/UpdateAdmin.vue';
import ClearAdmin from './wasm/ClearAdmin.vue';

const props = defineProps({
    type: String,
    endpoint: { type: String, required: true },
    sender: { type: String, required: true },
    hdPath: String,
    registryName: String,
    params: String,
});

const msgType = computed(() => {
    switch (props.type?.toLowerCase()) {
        case 'send':
            return Send;
        case 'delegate':
            return Delegate;
        case 'withdraw':
            return Withdraw;
        case 'withdraw_commission':
            return WithdrawCommission;
        case 'redelegate':
            return Redelegate;
        case 'transfer':
            return Transfer;
        case 'unbond':
            return Unbond;
        case 'vote':
            return Vote;
        case 'deposit':
            return Deposit;
        case 'wasm_store_code':
            return StoreCode;
        case 'wasm_execute_contract':
            return ExecuteContract;
        case 'wasm_instantiate_contract':
            return InstantiateContract;
        case 'wasm_migrate_contract':
            return MigrateContract;
        case 'wasm_update_admin':
            return UpdateAdmin;
        case 'wasm_clear_admin':
            return ClearAdmin;
        default:
            return Send;
    }
});

const advance = ref(false);
const sending = ref(false);
const balance = ref([] as Coin[]);
const metadatas = ref({} as Record<string, CoinMetadata>);
const emit = defineEmits(['submited', 'confirmed', 'view']);

// functional variable
const p = ref({} as { fees: Coin });
const view = ref('input'); // input, submitting
const open = ref(false);
const error = ref('');
const loading = ref(false);
const pendingReads = ref<string[]>([]);
const balanceReady = ref(false);
const loadError = ref('');
const progress = ref({title: '', description: ''});

// input field
const msgBox = ref({
    msgs: [],
    isValid: { ok: false, error: '' },
    initial: function () { },
});
const feeAmount = ref(2000);
const feeDenom = ref('');
const gasInfo = ref(200000);
const memo = ref('');
const chainId = ref('');
const formContext = computed(() => {
    const context = JSON.parse(props.params || '{}').form_context;
    return props.type === 'delegate' && context?.owner === props.sender && context?.endpoint === props.endpoint ? context : null;
});
// const chainId = ref('taproot-1');
const broadcast = ref(BroadcastMode.SYNC);

// A dialog session owns its form, network reads and receipt polling.
let dialogRevision = 0;
let receiptTimer: ReturnType<typeof setTimeout> | undefined;
function invalidateDialog() {
    dialogRevision++;
    if (receiptTimer !== undefined) clearTimeout(receiptTimer);
    receiptTimer = undefined;
}
async function initData() {
    invalidateDialog();
    const revision = dialogRevision;
    const active = () => revision === dialogRevision && open.value;
    view.value = 'input';
    error.value = ''; msg.value = ''; hash.value = '';
    progress.value = {title: '', description: ''};
    pending.value = false; delay.value = 0; step.value = 0;
    sending.value = false; advance.value = false;
    loading.value = false; loadError.value = ''; pendingReads.value = []; balanceReady.value = false;
    balance.value = []; metadatas.value = {}; chainId.value = '';
    feeAmount.value = 2000; feeDenom.value = ''; gasInfo.value = 200000;
    broadcast.value = BroadcastMode.SYNC; memo.value = ''; p.value = {} as { fees: Coin };
    if (!open.value || !props.endpoint || !props.sender) return;
    loading.value = true;
    const endpoint = props.endpoint, sender = props.sender, registryName = props.registryName;
    try {
        p.value = JSON.parse(props.params || '{}');
        const options = JSON.parse(props.params || '{}').staking_options;
        const suppliedDenom = props.type === 'delegate' && typeof options?.params?.bond_denom === 'string' ? options.params.bond_denom : '';
        memo.value = props.type?.toLowerCase() === 'send' ? '' : 'ping.pub';
        feeAmount.value = Number(p.value?.fees?.amount || 2000);
        if (['doravota', 'doravotatestnet'].includes(registryName || '')) {
            metadatas.value.peaka = { description: 'Dora Vota native token', base: 'peaka', display: 'DORA', name: 'Dora', symbol: 'DORA', uri: '', uri_hash: '', denom_units: [{ denom: 'peaka', exponent: 0, aliases: [] }, { denom: 'DORA', exponent: 18, aliases: ['dora'] }] };
        }
        const track = (label: string, task: Promise<unknown>) => {
            pendingReads.value.push(label);
            return task.catch(err => { if (active()) loadError.value = `${label}: ${String(err)}`; })
                .finally(() => { if (active()) pendingReads.value = pendingReads.value.filter(x => x !== label); });
        };
        const balanceRead = props.type === 'delegate' ? Promise.resolve().then(() => {
            if (!active()) return;
            const cached = formContext.value?.balances;
            if (Array.isArray(cached)) { balance.value = cached; balanceReady.value = true; }
        }) : track('Account balance', getBalance(endpoint, sender).then(x => {
            if (!active()) return;
            balance.value = x.balances; balanceReady.value = true;
            x.balances?.forEach(coin => {
                if (coin.denom.length < 12) getBalanceMetadata(endpoint, coin.denom).then(meta => {
                    if (active() && meta.metadata) metadatas.value[coin.denom] = meta.metadata;
                }).catch(() => {});
                if (coin.denom.startsWith('ibc/')) getIBCDenomMetadata(coin.denom).then(meta => {
                    if (active() && meta) metadatas.value[coin.denom] = meta;
                }).catch(() => {});
            });
        }));
        if (registryName && Object.keys(metadatas.value).length === 0) {
            new ChainRegistryClient().fetchAssetsList(registryName).then(x => {
                if (active()) x.assets.forEach(a => { metadatas.value[a.base] = a as CoinMetadata; });
            }).catch(() => {});
        }
        const chainRead = props.type === 'delegate' ? Promise.resolve(chainId.value = formContext.value?.chainId || '') : track('Network identity', getChainId(endpoint).then(id => { if (active()) chainId.value = id; }));
        const feeRead = suppliedDenom ? Promise.resolve(feeDenom.value = suppliedDenom) : track('Network parameters', getStakingParam(endpoint).then(res => { if (active()) feeDenom.value = res?.params?.bond_denom; }));
        // Wait until the new message component and parameters have rendered.
        await nextTick();
        if (!active()) return;
        const formRead = track('Transaction options', Promise.resolve().then(() => msgBox.value?.initial?.()));
        await Promise.all([balanceRead, chainRead, feeRead, formRead]);
    } catch (err) { if (active()) loadError.value = String(err); }
    finally { if (active()) loading.value = false; }
}
async function sendTx() {
    if (sending.value) return;
    const revision = dialogRevision, eventType = props.type;
    const active = () => revision === dialogRevision && open.value;
    let attemptedHash = '';
    try {
        if (['doravota', 'doravotatestnet'].includes(props.registryName || '') && props.type?.startsWith('wasm_')) throw new Error('Wasm execution is retired on Vota 1.0.0');
        if (props.type !== 'delegate' && !chainId.value) throw Error('Network connection is not ready. Please retry shortly.');
        if (!props.sender) throw new Error('Sender should not be empty!');
        if (!props.endpoint) throw new Error('Endpoint is empty');
        if (!feeDenom.value) throw new Error('Fee Denom is empty');
        if (!msgBox.value?.isValid?.ok)
            throw new Error(msgBox.value?.isValid?.error || 'Transaction form is not ready.');

        const messages = msgBox.value.msgs;
        sending.value = true;
        progress.value = {title: 'Preparing transaction', description: 'Checking your account and network fee.'};
        view.value = 'processing';

        if (eventType === 'delegate') {
            progress.value = {title: 'Checking before signing', description: 'Refreshing your balance and verifying the network. No signature has been requested.'};
            const reads = await Promise.allSettled([getChainId(props.endpoint), getBalance(props.endpoint, props.sender)]);
            if (!active()) return;
            const failures = reads.flatMap((result, i) => result.status === 'rejected' ? [`${i === 0 ? 'Network' : 'Balance'}: ${String(result.reason)}`] : []);
            if (failures.length) throw Error(failures.join(' / '));
            const id = (reads[0] as PromiseFulfilledResult<string>).value;
            const fresh = (reads[1] as PromiseFulfilledResult<{balances: Coin[]}>).value;
            if (formContext.value?.chainId && id !== formContext.value.chainId) throw Error('Network mismatch. No transaction was signed or sent.');
            if (!Array.isArray(fresh.balances)) throw Error('Balance response is invalid. Please retry.');
            chainId.value = id; balance.value = fresh.balances; balanceReady.value = true;
            for (const message of messages as any[]) {
                const coin = message.value.amount;
                const available = fresh.balances.find(x => x.denom === coin.denom)?.amount || '0';
                if (BigInt(coin.amount) > BigInt(available)) throw Error('Insufficient balance for this delegation. Your entered amount has been kept.');
            }
        }
        const acc = await getAccount(props.endpoint, props.sender);
        if (!active()) return;

        const tx = {
            chainId: chainId.value,
            signerAddress: props.sender,
            messages,
            fee: {
                gas: "400000",
                amount: [
                    { amount: String(feeAmount.value), denom: feeDenom.value },
                ],
            },
            memo: memo.value,
            signerData: {
                accountNumber: parseAccountNumber(acc.account.account_number),
                sequence: parseSequence(acc.account.sequence),
                chainId: chainId.value,
            },
        };
        // console.log('tx:', tx);
        const current = readWallet(props.hdPath);
        const wallet = current ? current.wallet : WalletName.Keplr;
        const client = new UniClient(wallet, {
            chainId: chainId.value,
            hdPath: current?.hdPath,
        });

        const response = await client.execute(props.endpoint, tx, broadcast.value, async (tx) => {
        if(!advance.value) {
            await client.simulate(props.endpoint, tx, broadcast.value).then(gas => {
                // update tx gas
                tx.fee.gas = (gas * 1.25).toFixed()
            }).catch(() => {
                // sending.value = false;
                // error.value = "Failed to simulate tx gas: " + err;
                if (active()) advance.value = true;
            })
        } else {
            tx.fee.gas = gasInfo.value.toString()
        }

        }, status => {
            if (!active()) return;
            progress.value = status; view.value = 'processing'; error.value = '';
        });
        if (!active()) return;
        attemptedHash = response.tx_response.txhash.toUpperCase();
        if (response.tx_response.txhash.toUpperCase() !== attemptedHash) throw new Error('Broadcast hash mismatch');
        // show submitting view
        hash.value = response.tx_response.txhash
        if (response.tx_response.state === 'rejected') {
            view.value = 'submitting'; pending.value = false; step.value = 0; sending.value = false;
            error.value = response.tx_response.raw_log || 'Transaction rejected by the node.';
        } else if (Number(response.tx_response.height) > 0) acceptReceipt(response.tx_response, response.tx_response.txhash, eventType);
        else showResult(response.tx_response.txhash);

        emit('submited', {
            hash: response.tx_response.txhash,
            eventType,
        });
    } catch (e) {
        if (!active()) return;
        if (attemptedHash && !(e instanceof BroadcastRejectedError)) {
            hash.value = attemptedHash;
            showResult(attemptedHash);
            msg.value = 'Broadcast result unknown. Checking the transaction hash. Do not send again.';
        } else {
            view.value = 'input';
            sending.value = false;
            error.value = String(e);
        }
    }
}

function viewTransaction() {
    emit('view', {
        hash: hash.value,
        eventType: props.type,
    });
    open.value = false
}

function showTitle() {
    return (props.type || 'Sending Transaction').replace(/\_/g, ' ');
}

const delay = ref(0);
const step = ref(0);
const msg = ref('');
const sleep = 6000;
const hash = ref('');
const pending = ref(false);

function showResult(hash: string) {
    view.value = 'submitting';
    delay.value = 1;
    step.value = 0;
    error.value = '';
    pending.value = true;
    msg.value = 'Checking transaction. Do not send again until the result is confirmed.';
    if (receiptTimer !== undefined) clearTimeout(receiptTimer);
    const revision = dialogRevision, endpoint = props.endpoint, eventType = props.type;
    receiptTimer = setTimeout(() => fetchTx(hash, revision, endpoint, eventType), sleep);
}

function fetchTx(tx: string, revision: number, endpoint: string, eventType: string | undefined) {
    const active = () => revision === dialogRevision && open.value && hash.value === tx;
    if (!active()) return;
    delay.value += 1;

    getTxByHash(endpoint, tx)
        .then((res) => {
            if (!active()) return;
            acceptReceipt(res.tx_response, tx, eventType);
        })
        .catch(() => {
            if (!active()) return;
            if (delay.value < 5) {
                receiptTimer = setTimeout(() => fetchTx(tx, revision, endpoint, eventType), sleep);
            } else {
                step.value = 0;
                msg.value = 'Result pending confirmation. The transaction may already be on chain. Check this hash before sending again.';
            }
        });
}
function acceptReceipt(response: any, tx: string, eventType: string | undefined) {
    if (!response || response.txhash?.toUpperCase() !== tx.toUpperCase() || !/^[0-9]+$/.test(String(response.code)) || Number(response.height) <= 0) throw new Error('Transaction not confirmed');
    view.value = 'submitting'; pending.value = false; step.value = 100;
    error.value = ''; sending.value = false;
    if (Number(response.code) > 0) error.value = response.raw_log || 'Transaction execution failed.';
    else { msg.value = `Transaction confirmed: ${(eventType || 'transaction').replace(/_/g, ' ')}.`; emit('confirmed', { hash: tx, eventType }); }
    // Let the host independently reconcile its saved pending receipt. Never rebroadcast.
    Promise.resolve((window as any).doraPqcTransactions?.settled?.({owner: props.sender, chainId: chainId.value, txhash: tx})).catch(() => {});
}

// Prop changes can switch actions while the checkbox remains open.
watch(() => [open.value, props.type, props.params, props.sender, props.endpoint], initData, { flush: 'post' });
onUnmounted(invalidateDialog);
</script>
<template>
    <div class="text-gray-600">
        <!-- Put this part before </body> tag -->
        <input v-model="open" type="checkbox" :id="type" class="modal-toggle" />
        <label :for="type" class="modal cursor-pointer">
            <label class="modal-box relative p-5" :class="{ '!w-11/12 !max-w-5xl': String(type).startsWith('wasm') }" for="">
                <label :for="type" class="btn btn-sm btn-circle absolute right-4 top-4">✕</label>
                <h3 class="text-lg font-bold capitalize dark:text-gray-300">
                    {{ showTitle() }}
                </h3>

                <div v-if="!sender" class="text-center h-16 items-center">
                    No wallet connected!
                </div>

                <div v-if="sender">
                    <div v-if="open" v-show="view === 'input'">
                        <div v-if="loading" class="my-4 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-200" role="status"><span class="loading loading-spinner loading-xs"></span>Loading: {{ pendingReads.join(', ') }}…</div>
                        <div v-if="loadError" class="my-5 rounded-xl border border-red-300 p-4 text-gray-700 dark:text-gray-100" role="alert">
                            <p>Unable to load transaction details. No transaction has been signed or sent.</p>
                            <p class="text-sm mt-2">{{ loadError }}</p>
                            <button class="btn btn-sm mt-3" @click="initData()">Retry loading</button>
                        </div>
                        <component :is="msgType" :key="[type, sender, endpoint, props.params].join('|')" ref="msgBox" :endpoint="endpoint" :sender="sender" :balances="balance" :balance-ready="balanceReady"
                            :metadata="metadatas" :params="props.params" />
                        <form class="space-y-6" action="#" method="POST">
                            <div :class="advance ? '' : 'hidden'">
                                <div class="form-control">
                                    <label class="label">
                                        <span class="label-text">Fees</span>
                                    </label>
                                    <label class="input-group flex items-center">
                                        <input v-model="feeAmount" type="text" placeholder="0.001"
                                            class="input border border-gray-300 dark:border-gray-600 flex-1 w-0 dark:text-gray-300" />
                                        <select v-model="feeDenom"
                                            class="select input border border-gray-300 dark:border-gray-600 w-[200px]">
                                            <option disabled selected>
                                                Select Fee Token
                                            </option>
                                            <option v-for="t in balance">
                                                {{ t.denom }}
                                            </option>
                                        </select>
                                    </label>
                                </div>
                                <div class="form-control">
                                    <label class="label">
                                        <span class="label-text">Gas</span>
                                    </label>
                                    <input v-model="gasInfo" type="number" placeholder="2000000"
                                        class="input border border-gray-300 dark:border-gray-600 dark:text-gray-300" />
                                </div>
                                <div class="form-control">
                                    <label class="label">
                                        <span class="label-text">Memo</span>
                                    </label>
                                    <input v-model="memo" type="text" placeholder="Memo"
                                        class="input border border-gray-300 dark:border-gray-600 dark:text-gray-300" />
                                </div>
                                <div class="form-control">
                                    <label class="label">
                                        <span class="label-text">Broadcast Mode</span>
                                    </label>
                                    <select v-model="broadcast"
                                        class="select input border border-gray-300 dark:border-gray-600 w-[200px]">
                                        <option :value="BroadcastMode.SYNC">Sync</option>
                                        <option :value="BroadcastMode.ASYNC">Async</option>
                                        <option :value="BroadcastMode.BLOCK">Block</option>
                                    </select>
                                </div>
                            </div>
                        </form>

                        <div v-show="error" class="mt-5 alert alert-error shadow-lg" @click="error = ''">
                            <div class="flex">
                                <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current flex-shrink-0 h-6 w-6"
                                    fill="none" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                        d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                </svg>
                                <span>{{ error }}.</span>
                            </div>
                        </div>

                        <div class="modal-action flex justify-between items-center">
                            <div class="flex items-center cursor-pointer">
                                <input v-model="advance" type="checkbox" :id="`${type}-advance`"
                                    class="checkbox checkbox-sm checkbox-primary mr-2" /><label :for="`${type}-advance`"
                                    class="cursor-pointer dark:text-gray-400">Advance</label>
                            </div>
                            <button class="btn btn-primary" @click="sendTx()" :disabled="loading || !!loadError || sending || (type !== 'delegate' && !chainId) || !feeDenom || !msgBox?.isValid?.ok">
                                <span v-if="sending" class="loading loading-spinner"></span>
                                Send
                            </button>
                        </div>
                    </div>

                    <div v-if="view === 'processing'" class="py-10 text-center" role="status" aria-live="polite"><span class="loading loading-spinner text-primary mb-4"></span><h4 class="text-lg font-semibold">{{ progress.title }}</h4><p class="mt-4 leading-7">{{ progress.description }}</p></div>
                    <div v-if="view === 'submitting'">
                        <div class="my-10">
                            <div v-if="error" class="my-5 text-center text-red-500">
                                {{ error }}
                            </div>
                            <div v-else :class="pending ? 'my-5 text-center text-lg text-amber-600' : 'my-5 text-center text-lg text-green-500'">
                                {{ msg }}
                            </div>
                            <div v-if="!pending" class="overflow-hidden h-5 mb-2 text-xs flex rounded bg-green-100">
                                <div :style="`width: ${step}%`"
                                    class="shadow-none flex flex-col text-center whitespace-nowrap text-white justify-center bg-green-400">
                                </div>
                            </div>
                            <div class="flex items-center justify-between">
                                <div>
                                    <span
                                        class="text-xs font-semibold inline-block py-1 px-2 rounded text-gray-600 dark:text-white">
                                        {{ pending ? 'Waiting for confirmation' : error ? 'Failed' : 'Confirmed' }}
                                    </span>
                                </div>
                                <div v-if="!pending" class="text-right">
                                    <span class="text-xs font-semibold inline-block text-gray-600 dark:text-white">
                                        {{ step }}%
                                    </span>
                                </div>
                            </div>
                        </div>
                        <p class="text-xs break-all">Transaction hash: {{ hash }}</p>
                        <button v-if="pending && delay >= 5" class="btn btn-sm" @click="showResult(hash)">Check status</button>
                        <label class="mt-10 flex justify-center text-sm" @click="viewTransaction">
                            <span>View Transaction</span>
                        </label>
                    </div>
                </div>
            </label>
        </label>
    </div>
</template>
<script lang="ts">
export default {
    name: 'TxDialog',
};
</script>
