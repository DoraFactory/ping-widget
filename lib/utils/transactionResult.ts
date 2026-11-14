// Strict node-response validation shared by broadcast and receipt rendering.
export function transactionResult(response: any, expectedHash: string, included = false) {
    if (!/^[0-9a-f]{64}$/i.test(expectedHash) || typeof response?.txhash !== 'string' ||
        response.txhash.toUpperCase() !== expectedHash.toUpperCase()) throw Error('Transaction hash mismatch');
    const code = response.code;
    if (!((typeof code === 'number' && Number.isSafeInteger(code)) ||
        (typeof code === 'string' && /^(0|[1-9][0-9]*)$/.test(code))) ||
        BigInt(code) < 0n || BigInt(code) > 0xffffffffn) throw Error('Invalid transaction result code');
    if (included) {
        const height = response.height;
        if (!((typeof height === 'string' && /^[1-9][0-9]*$/.test(height)) ||
            (typeof height === 'number' && Number.isSafeInteger(height) && height > 0)) ||
            BigInt(height) > 0x7fffffffffffffffn) throw Error('Transaction not confirmed: invalid inclusion height');
    }
    return {...response, txhash: expectedHash.toUpperCase(), code: Number(code)};
}
export const pendingTransactionKey = (chain: string, owner: string) =>
    'vota-widget:pending:' + JSON.stringify([chain, owner]);
export class PendingTransactionError extends Error {
    constructor(public txhash: string) { super('Transaction outcome unknown. Check this hash before sending again: ' + txhash); }
}
