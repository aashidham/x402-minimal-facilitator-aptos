/**
 * Minimal x402 Facilitator for Aptos Testnet
 *
 * Supports sponsored (gasless) transactions where the facilitator pays gas.
 *
 * Endpoints:
 *   POST /verify  - Verify a payment without executing
 *   POST /settle  - Submit transaction on-chain
 *   GET /supported - List supported networks/schemes
 */

import express from 'express';
import morgan from 'morgan';
import {
  Account,
  Aptos,
  AptosConfig,
  Ed25519PrivateKey,
  Network,
  AccountAddress,
  Deserializer,
  SimpleTransaction,
  AccountAuthenticator
} from '@aptos-labs/ts-sdk';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

// Configuration
const PORT = process.env.PORT || 4022;
const APTOS_PRIVATE_KEY = process.env.APTOS_PRIVATE_KEY;
const NETWORK = 'aptos:2'; // testnet

if (!APTOS_PRIVATE_KEY) {
  console.error('ERROR: APTOS_PRIVATE_KEY environment variable required');
  process.exit(1);
}

// Initialize facilitator account (fee payer)
const privateKeyHex = APTOS_PRIVATE_KEY.startsWith('0x') ? APTOS_PRIVATE_KEY.slice(2) : APTOS_PRIVATE_KEY;
const privateKey = new Ed25519PrivateKey(privateKeyHex);
const feePayerAccount = Account.fromPrivateKey({ privateKey });

// Aptos client
const aptosConfig = new AptosConfig({ network: Network.TESTNET });
const aptos = new Aptos(aptosConfig);

console.log(`Fee Payer Account: ${feePayerAccount.accountAddress.toStringLong()}`);

// Pretty print helper
function logJson(label, obj) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📋 ${label}`);
  console.log('─'.repeat(60));
  console.log(JSON.stringify(obj, null, 2));
  console.log('─'.repeat(60) + '\n');
}

/**
 * Deserialize the Aptos payment from the payload
 * Format: base64(JSON({ transaction: number[], senderAuthenticator: number[] }))
 */
function deserializeAptosPayment(transactionBase64) {
  const decoded = Buffer.from(transactionBase64, 'base64').toString('utf8');
  const parsed = JSON.parse(decoded);

  const transactionBytes = Uint8Array.from(parsed.transaction);
  const transaction = SimpleTransaction.deserialize(new Deserializer(transactionBytes));

  const authBytes = Uint8Array.from(parsed.senderAuthenticator);
  const senderAuthenticator = AccountAuthenticator.deserialize(new Deserializer(authBytes));

  // Extract entry function if present
  let entryFunction = null;
  if (transaction.rawTransaction.payload && 'entryFunction' in transaction.rawTransaction.payload) {
    entryFunction = transaction.rawTransaction.payload.entryFunction;
  }

  return { transaction, senderAuthenticator, entryFunction };
}

/**
 * Verify a payment payload against requirements
 */
async function verifyPayment(paymentPayload, paymentRequirements) {
  try {
    const aptosPayload = paymentPayload.payload;

    // Check scheme
    if (paymentPayload.accepted.scheme !== 'exact' || paymentRequirements.scheme !== 'exact') {
      return { isValid: false, invalidReason: 'unsupported_scheme', payer: '' };
    }

    // Check network
    if (paymentPayload.accepted.network !== paymentRequirements.network) {
      return { isValid: false, invalidReason: 'network_mismatch', payer: '' };
    }

    // Deserialize transaction
    const { transaction, senderAuthenticator, entryFunction } = deserializeAptosPayment(aptosPayload.transaction);
    const senderAddress = transaction.rawTransaction.sender.toString();

    // Must have entry function
    if (!entryFunction) {
      return { isValid: false, invalidReason: 'invalid_payment_missing_entry_function', payer: senderAddress };
    }

    // Verify it's calling 0x1::primary_fungible_store::transfer
    const moduleAddress = entryFunction.module_name.address;
    const moduleName = entryFunction.module_name.name.identifier;
    const functionName = entryFunction.function_name.identifier;

    if (!AccountAddress.ONE.equals(moduleAddress) || moduleName !== 'primary_fungible_store' || functionName !== 'transfer') {
      return { isValid: false, invalidReason: 'invalid_payment_wrong_function', payer: senderAddress };
    }

    // Verify type args (should have 1: the Metadata type)
    if (entryFunction.type_args.length !== 1) {
      return { isValid: false, invalidReason: 'invalid_payment_wrong_type_args', payer: senderAddress };
    }

    // Verify function args: [asset, recipient, amount]
    const args = entryFunction.args;
    if (args.length !== 3) {
      return { isValid: false, invalidReason: 'invalid_payment_wrong_args', payer: senderAddress };
    }

    const [faAddressArg, recipientAddressArg, amountArg] = args;

    // Check asset matches
    const faAddress = AccountAddress.from(faAddressArg.bcsToBytes());
    const expectedAsset = AccountAddress.from(paymentRequirements.asset);
    if (!faAddress.equals(expectedAsset)) {
      return { isValid: false, invalidReason: 'invalid_payment_asset_mismatch', payer: senderAddress };
    }

    // Check recipient matches
    const recipientAddress = AccountAddress.from(recipientAddressArg.bcsToBytes());
    const expectedPayTo = AccountAddress.from(paymentRequirements.payTo);
    if (!recipientAddress.equals(expectedPayTo)) {
      return { isValid: false, invalidReason: 'invalid_payment_recipient_mismatch', payer: senderAddress };
    }

    // Check amount matches
    const amount = new Deserializer(amountArg.bcsToBytes()).deserializeU64().toString(10);
    if (amount !== paymentRequirements.amount) {
      return { isValid: false, invalidReason: 'invalid_payment_amount_mismatch', payer: senderAddress };
    }

    // Simulate transaction to verify it would succeed
    try {
      let publicKey;
      if (senderAuthenticator.isEd25519()) {
        publicKey = senderAuthenticator.public_key;
      } else if (senderAuthenticator.isSingleKey()) {
        publicKey = senderAuthenticator.public_key;
      } else if (senderAuthenticator.isMultiKey()) {
        publicKey = senderAuthenticator.public_keys;
      }

      const simulationResult = (await aptos.transaction.simulate.simple({
        signerPublicKey: publicKey,
        transaction
      }))[0];

      if (!simulationResult.success) {
        return { isValid: false, invalidReason: `simulation_failed: ${simulationResult.vm_status}`, payer: senderAddress };
      }
    } catch (error) {
      return { isValid: false, invalidReason: `simulation_error: ${error.message}`, payer: senderAddress };
    }

    return { isValid: true, payer: senderAddress };

  } catch (error) {
    console.error('Verify error:', error);
    return { isValid: false, invalidReason: 'unexpected_verify_error', payer: '' };
  }
}

/**
 * Settle a payment by submitting the transaction on-chain
 */
async function settlePayment(paymentPayload, paymentRequirements) {
  // First verify
  const verifyResult = await verifyPayment(paymentPayload, paymentRequirements);
  if (!verifyResult.isValid) {
    return {
      success: false,
      network: paymentPayload.accepted.network,
      transaction: '',
      errorReason: verifyResult.invalidReason || 'verification_failed',
      payer: verifyResult.payer || ''
    };
  }

  try {
    const { transaction, senderAuthenticator } = deserializeAptosPayment(paymentPayload.payload.transaction);
    const senderAddress = transaction.rawTransaction.sender.toStringLong();
    const sponsored = paymentRequirements.extra?.sponsored === true;

    let pendingTxn;

    if (sponsored) {
      // Set fee payer address and sign as fee payer
      transaction.feePayerAddress = feePayerAccount.accountAddress;

      const feePayerAuthenticator = aptos.transaction.signAsFeePayer({
        signer: feePayerAccount,
        transaction
      });

      pendingTxn = await aptos.transaction.submit.simple({
        transaction,
        senderAuthenticator,
        feePayerAuthenticator
      });
    } else {
      // Non-sponsored: just submit with sender's auth
      pendingTxn = await aptos.transaction.submit.simple({
        transaction,
        senderAuthenticator
      });
    }

    // Wait for transaction
    await aptos.waitForTransaction({ transactionHash: pendingTxn.hash });

    return {
      success: true,
      transaction: pendingTxn.hash,
      network: paymentPayload.accepted.network,
      payer: senderAddress
    };

  } catch (error) {
    console.error('Settle error:', error);
    return {
      success: false,
      errorReason: `transaction_failed: ${error.message}`,
      transaction: '',
      network: paymentPayload.accepted.network,
      payer: verifyResult.payer || ''
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /verify
 * Verify a payment without executing
 */
app.post('/verify', async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({ isValid: false, invalidReason: 'missing_parameters' });
    }

    logJson('VERIFY REQUEST', { paymentPayload, paymentRequirements });

    const result = await verifyPayment(paymentPayload, paymentRequirements);

    logJson('VERIFY RESPONSE', result);

    res.json(result);
  } catch (error) {
    console.error('Verify endpoint error:', error);
    res.status(500).json({ isValid: false, invalidReason: error.message });
  }
});

/**
 * POST /settle
 * Submit the transaction on-chain
 */
app.post('/settle', async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({ success: false, errorReason: 'missing_parameters' });
    }

    logJson('SETTLE REQUEST', { paymentPayload, paymentRequirements });

    const result = await settlePayment(paymentPayload, paymentRequirements);

    logJson('SETTLE RESPONSE', result);

    res.json(result);
  } catch (error) {
    console.error('Settle endpoint error:', error);
    res.status(500).json({ success: false, errorReason: error.message });
  }
});

/**
 * GET /supported
 * Return supported networks and schemes
 */
app.get('/supported', (req, res) => {
  res.json({
    kinds: [
      {
        x402Version: 2,
        scheme: 'exact',
        network: NETWORK,
        extra: { sponsored: true }
      }
    ],
    signers: {
      [NETWORK]: feePayerAccount.accountAddress.toStringLong()
    }
  });
});

/**
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    network: NETWORK,
    feePayer: feePayerAccount.accountAddress.toStringLong()
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║         x402 Minimal Aptos Facilitator                     ║
╠════════════════════════════════════════════════════════════╣
║  Network:     ${NETWORK.padEnd(43)}║
║  Fee Payer:   ${feePayerAccount.accountAddress.toString().slice(0, 10)}...${feePayerAccount.accountAddress.toString().slice(-8).padEnd(28)}║
║  Port:        ${String(PORT).padEnd(43)}║
╠════════════════════════════════════════════════════════════╣
║  Endpoints:                                                ║
║    POST /verify     - Verify payment                       ║
║    POST /settle     - Submit transaction on-chain          ║
║    GET  /supported  - List supported schemes               ║
║    GET  /health     - Health check                         ║
╚════════════════════════════════════════════════════════════╝
`);
});
