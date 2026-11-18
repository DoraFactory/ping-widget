import { transactionResult, pendingTransactionKey, PendingTransactionError } from '../utils/transactionResult';
import { toBase64, fromBase64, toHex, fromBech32 } from "@cosmjs/encoding";
import { EncodeObject, encodePubkey, Registry } from '@cosmjs/proto-signing'
import { encodeSecp256k1Pubkey } from "@cosmjs/amino";
import { defaultRegistryTypes } from "@cosmjs/stargate";
import { AuthInfo, TxBody, TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { AbstractWallet, WalletArgument, WalletName, createWallet } from "./Wallet";
import { post, getTxByHash } from "../utils/http";
import { BroadcastMode, Transaction, TxResponse } from "../utils/type";
import { wasmTypes } from "@cosmjs/cosmwasm-stargate";
import { makeAuthInfoBytes, makeSignDoc, TxBodyEncodeObject } from "@cosmjs/proto-signing";
import { Any } from "cosmjs-types/google/protobuf/any";

export class BroadcastRejectedError extends Error {
  txResponse: any
  constructor(message: string, response?: any) { super(message); this.txResponse = response; }
}

export function isEthermint(chainId: string) {
  return chainId.search(/\w+_\d+-\d+/g) > -1
}

export class UniClient {
    registry: Registry
    wallet: AbstractWallet
    walletName: WalletName
    constructor(name: WalletName, arg: WalletArgument) {
        this.walletName = name
        this.registry = new Registry([...defaultRegistryTypes, ...wasmTypes])
        this.wallet = createWallet(name, arg, this.registry)
    }

    // One explicit integration point for host applications; wallet APIs stay untouched.
    async execute(endpoint: string, transaction: Transaction, mode = BroadcastMode.SYNC,
        prepareClassic: (tx: Transaction) => Promise<void> = async () => {},
        onProgress?: (status: {title: string; description: string}) => void,
        lifecycle: {manualFeesEdited?: boolean; assertActive?: () => void; onBroadcast?: (hash: string) => void} = {}) {
        transaction = structuredClone(transaction);
        const assertActive = lifecycle.assertActive || (() => {});
        assertActive();
        const classic = async (checkpoint?: (stage: string, details?: any) => Promise<void | string>) => {
            const run = async () => {
                const key = pendingTransactionKey(transaction.chainId, transaction.signerAddress);
                // The host coordinator owns its journal; standalone callers use this one.
                const storage = checkpoint ? null : globalThis.localStorage;
                if (!checkpoint && !storage) throw Error('Persistent transaction storage is unavailable');
                const pending = storage?.getItem(key);
                if (pending) {
                    const record = JSON.parse(pending);
                    if (record.owner !== transaction.signerAddress || record.chainId !== transaction.chainId ||
                        !/^[0-9a-f]{64}$/i.test(record.txhash)) throw Error('Invalid pending transaction record');
                    let receipt;
                    try {
                        receipt = transactionResult((await getTxByHash(endpoint, record.txhash)).tx_response, record.txhash, true);
                    } catch { throw new PendingTransactionError(record.txhash); }
                    assertActive();
                    lifecycle.onBroadcast?.(record.txhash);
                    storage!.removeItem(key);
                    // Resolve the old operation. Never turn a retry into a second payment.
                    return {tx_response: receipt};
                }
                assertActive();
                const tx = structuredClone(transaction);
                await prepareClassic(tx); assertActive();
                const deadline = await checkpoint?.('sign'); assertActive();
                if (typeof deadline === 'string') tx.timeoutHeight = BigInt(deadline);
                const raw = structuredClone(await this.sign(tx)); assertActive();
                const { sha256 } = await import('@cosmjs/crypto'); assertActive();
                const hash = toHex(sha256(TxRaw.encode(raw).finish())).toUpperCase();
                try {
                    if (checkpoint) {
                        const signers = AuthInfo.decode(raw.authInfoBytes).signerInfos;
                        if (signers.length !== 1) throw Error('Expected a single transaction signer');
                        await checkpoint('broadcast', { hash, sequence: signers[0].sequence.toString(),
                            timeoutHeight: TxBody.decode(raw.bodyBytes).timeoutHeight.toString() });
                    }
                    assertActive();
                    storage?.setItem(key, JSON.stringify({owner: tx.signerAddress, chainId: tx.chainId, txhash: hash}));
                    lifecycle.onBroadcast?.(hash); assertActive();
                } catch (cause) {
                    // This adapter has not entered broadcast yet, even if the host reserved a hash.
                    storage?.removeItem(key);
                    const error = new Error(cause instanceof Error ? cause.message : String(cause));
                    (error as any).code = 'BROADCAST_NOT_ATTEMPTED';
                    throw error;
                }
                // No await between recording the attempt and entering broadcast.
                try {
                    const response = await this.broadcastTx(endpoint, raw, mode, hash);
                    if (Number(response.tx_response.height) > 0) {
                        transactionResult(response.tx_response, hash, true);
                        storage?.removeItem(key);
                    }
                    return response;
                } catch (error) {
                    if (error instanceof BroadcastRejectedError) { storage?.removeItem(key); throw error; }
                    throw new PendingTransactionError(hash);
                }
            };
            if (checkpoint) return run();
            if (!globalThis.navigator?.locks) throw Error('Account-lock support is required');
            return navigator.locks.request('vota-widget:' + transaction.chainId + ':' + transaction.signerAddress,
                {ifAvailable: true}, lock => { if (!lock) throw Error('Another transaction is in progress'); return run(); });
        };
        const coordinator = (window as any).doraPqcTransactions;
        if (globalThis.localStorage?.getItem(pendingTransactionKey(transaction.chainId, transaction.signerAddress))) return classic();
        if (coordinator) return coordinator.execute({ transaction, wallet: this.walletName, onProgress, ...lifecycle }, classic);
        return classic();
    }

    async getAccounts() {
        return this.wallet.getAccounts()
    }

    async sign(transaction: Transaction): Promise<TxRaw> {
        // const { signature, signed } = await this.wallet.sign(transaction);
        // return TxRaw.fromPartial({
        //     bodyBytes: signed.bodyBytes,
        //     authInfoBytes: signed.authInfoBytes,
        //     signatures: [fromBase64(signature.signature)],
        // });
        return this.wallet.sign(transaction)
    }
    
    async simulate (
        endpoint: string,
        transaction: Transaction,
        mode: BroadcastMode = BroadcastMode.SYNC
      ) {

        const pubkey = Any.fromPartial({
            typeUrl: '/cosmos.crypto.ed25519.PubKey',
            value: new Uint8Array()
        })
        const txBodyEncodeObject: TxBodyEncodeObject = {
            typeUrl: "/cosmos.tx.v1beta1.TxBody",
            value: {
                messages: transaction.messages,
                timeoutHeight: transaction.timeoutHeight,
                memo: transaction.memo,
            },
        };

        const txBodyBytes = this.registry.encode(txBodyEncodeObject);
        const gasLimit = Number(transaction.fee.gas);
        const authInfoBytes = makeAuthInfoBytes(
            [{ pubkey, sequence: transaction.signerData.sequence }],
            transaction.fee.amount,
            gasLimit,
            transaction.fee.granter,
            transaction.fee.payer,
        );

        const txRaw =  TxRaw.fromPartial({
            bodyBytes: txBodyBytes,
            authInfoBytes: authInfoBytes,
            signatures: [new Uint8Array()],
        });

        const txbytes = toBase64(TxRaw.encode(txRaw).finish())
        const request = {
          tx_bytes: txbytes,
          mode, // BROADCAST_MODE_SYNC, BROADCAST_MODE_BLOCK, BROADCAST_MODE_ASYNC
        }
        return post(`${endpoint}/cosmos/tx/v1beta1/simulate`, request).then(res => {
          if (res.code && res.code !== 0) {
            throw new Error(res.message)
          }
          if (res.tx_response && res.tx_response.code !== 0) {
            throw new Error(res.tx_response.raw_log)
          }
          return Number(res.gas_info.gas_used)
        })
    }

    // async simulate2(
    //     endpoint: string, 
    //     messages: readonly EncodeObject[],
    //     memo: string | undefined,
    //     sequence: number
    // ) {
        
    //     const [first] = await this.wallet.getAccounts()
    //     const pubkey = encodeSecp256k1Pubkey(first.pubkey);
    //     const anyMsgs = messages.map((m) => this.registry.encodeAsAny(m));
    //     const url = `${endpoint}/cosmos/tx/v1beta1/simulate`
    //     const tx = Tx.fromPartial({
    //         authInfo: AuthInfo.fromPartial({
    //           fee: Fee.fromPartial({}),
    //           signerInfos: [
    //             {
    //               publicKey: encodePubkey(pubkey),
    //               sequence: sequence,
    //               modeInfo: { single: { mode: SignMode.SIGN_MODE_UNSPECIFIED } },
    //             },
    //           ],
    //         }),
    //         body: TxBody.fromPartial({
    //           messages: Array.from(anyMsgs),
    //           memo: memo,
    //         }),
    //         signatures: [new Uint8Array()],
    //       });
    //     const request = SimulateRequest.fromPartial({
    //         tx
    //         // txBytes: Tx.encode(tx).finish(),
    //     });
    //     console.log(tx, request)
    //     return await post(url, request)
    // }


  async broadcastTx(endpoint, bodyBytes: TxRaw, mode: BroadcastMode = BroadcastMode.SYNC, expectedHash?: string) : Promise<{tx_response: TxResponse}> {
    // const txbytes = bodyBytes.authInfoBytes ? TxRaw.encode(bodyBytes).finish() : bodyBytes
    const txbytes = TxRaw.encode(bodyBytes).finish() 
    const txString = toBase64(txbytes)
    const txRaw = {
      tx_bytes: txString,
      mode, // BROADCAST_MODE_SYNC, BROADCAST_MODE_BLOCK, BROADCAST_MODE_ASYNC
    }
    const hash = expectedHash || toHex((await import('@cosmjs/crypto')).sha256(txbytes)).toUpperCase();
    return post(`${endpoint}/cosmos/tx/v1beta1/txs`, txRaw).then(res => {
      const result = transactionResult(res.tx_response, hash);
      if (result.code !== 0) throw new BroadcastRejectedError(result.raw_log || 'Transaction rejected', result);
      return {tx_response: result};
    })
  }
}