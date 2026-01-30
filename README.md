# x402 Minimal Facilitator for Aptos

A minimal x402 facilitator that verifies and settles payments on Aptos testnet. Supports sponsored (gasless) transactions where the facilitator pays for gas.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        FACILITATOR                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   ┌──────────────┐    ┌──────────────┐    ┌──────────────┐     │
│   │   /verify    │    │   /settle    │    │  /supported  │     │
│   │              │    │              │    │              │     │
│   │ Validates:   │    │ 1. Verifies  │    │ Returns      │     │
│   │ - Function   │    │ 2. Signs as  │    │ supported    │     │
│   │ - Asset      │    │    fee payer │    │ networks &   │     │
│   │ - Recipient  │    │ 3. Submits   │    │ schemes      │     │
│   │ - Amount     │    │    to chain  │    │              │     │
│   │ - Simulates  │    │ 4. Waits for │    │              │     │
│   │              │    │    confirm   │    │              │     │
│   └──────────────┘    └──────────────┘    └──────────────┘     │
│                              │                                  │
│                              ▼                                  │
│                    ┌──────────────────┐                        │
│                    │   Aptos Testnet  │                        │
│                    │   (via SDK)      │                        │
│                    └──────────────────┘                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## File Structure

```
x402-minimal-facilitator/
├── facilitator.js     # Main server - all logic in one file
├── package.json       # Dependencies (express, @aptos-labs/ts-sdk)
├── .env.local         # Environment variables (create from env.example)
└── env.example        # Example environment file
```

## How It Works

### Payment Verification (`/verify`)

1. Deserializes the signed Aptos transaction from base64
2. Validates the transaction is calling `0x1::primary_fungible_store::transfer`
3. Checks the asset, recipient, and amount match requirements
4. Simulates the transaction to ensure it would succeed
5. Returns `{ isValid: true/false, invalidReason?, payer }`

### Payment Settlement (`/settle`)

1. Calls verify internally (verify is technically redundant if you always settle)
2. If sponsored: signs as fee payer so the client pays no gas
3. Submits transaction to Aptos testnet
4. Waits for confirmation
5. Returns `{ success: true/false, transaction, network, payer }`

## Setup

```bash
# Install dependencies
npm install

# Copy env file
cp env.example .env.local

# Edit .env.local with your private key
# This account will pay gas for sponsored transactions
```

## Running

```bash
npm start
```

The facilitator will start on port 4022 (or `PORT` env var).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `APTOS_PRIVATE_KEY` | Yes | Private key for fee payer account (hex with 0x prefix) |
| `PORT` | No | Server port (default: 4022) |

## API Endpoints

### POST /verify

Verify a payment without executing it.

**Request:**
```json
{
  "paymentPayload": {
    "x402Version": 2,
    "accepted": { "scheme": "exact", "network": "aptos:2", ... },
    "payload": { "transaction": "<base64>" }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "aptos:2",
    "amount": "10000",
    "asset": "0x69091...",
    "payTo": "0xabc..."
  }
}
```

**Response:**
```json
{
  "isValid": true,
  "payer": "0x123..."
}
```

### POST /settle

Submit the transaction on-chain.

**Request:** Same as /verify

**Response:**
```json
{
  "success": true,
  "transaction": "0xabc123...",
  "network": "aptos:2",
  "payer": "0x123..."
}
```

### GET /supported

List supported networks and schemes.

**Response:**
```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "aptos:2",
      "extra": { "sponsored": true }
    }
  ],
  "signers": {
    "aptos:2": "0xfee_payer_address..."
  }
}
```

### GET /health

Health check endpoint.

## Notable Implementation Details

### Verify is Optional

The `/settle` endpoint calls `verifyPayment()` internally before submitting. This means:
- You could skip `/verify` and go straight to `/settle`
- The server implementation calls both for explicit verification feedback
- In production, you might want to separate these for rate limiting or caching

### Sponsored Transactions

When `paymentRequirements.extra.sponsored === true`:
1. The facilitator sets itself as the fee payer
2. Signs the transaction as fee payer
3. Client pays 0 gas, facilitator pays gas

This is achieved using Aptos fee payer transactions:
```javascript
transaction.feePayerAddress = feePayerAccount.accountAddress;
const feePayerAuthenticator = aptos.transaction.signAsFeePayer({ signer: feePayerAccount, transaction });
```

### Transaction Format

The payment payload contains a base64-encoded JSON with:
```json
{
  "transaction": [/* BCS-serialized SimpleTransaction bytes */],
  "senderAuthenticator": [/* BCS-serialized AccountAuthenticator bytes */]
}
```

This matches the format used by `@rvk_rishikesh/aptos` in the workshop.

### RPC Configuration

Uses Aptos SDK defaults for testnet:
- Fullnode: `https://fullnode.testnet.aptoslabs.com/v1`
- Indexer: `https://indexer-testnet.staging.gcp.aptosdev.com/v1/graphql`

To use a custom RPC, modify `AptosConfig`:
```javascript
const aptosConfig = new AptosConfig({
  network: Network.TESTNET,
  fullnode: "https://your-custom-rpc.com/v1"
});
```

## Funding the Fee Payer

The fee payer account needs APT for gas. Fund it on testnet:

```bash
aptos account fund-with-faucet \
  --account YOUR_FEE_PAYER_ADDRESS \
  --url https://fullnode.testnet.aptoslabs.com
```

## Security Considerations

- The facilitator private key should be kept secure
- In production, add rate limiting and authentication
- Consider separating verify/settle for better control
- Monitor fee payer balance to avoid failed transactions

## Comparison to Official x402 Implementation

This minimal facilitator is a simplified, single-file version of the Aptos facilitator in the official [x402 repository](https://github.com/aptos-labs/x402).

### Structure Comparison

| Aspect | Official x402 (`github.com/aptos-labs/x402`) | This Repo |
|--------|----------------------------------------------|-----------|
| **Framework** | Next.js App Router | Express.js |
| **Language** | TypeScript | JavaScript |
| **Code Organization** | Modular packages (`@x402/core`, `@x402/aptos`) | Single file (`facilitator.js`) |
| **Hooks System** | Yes (`onBeforeVerify`, `onAfterSettle`, etc.) | No |
| **Lines of Code** | ~800+ across multiple files | ~350 in one file |

### Official x402 Structure

```
# From https://github.com/aptos-labs/x402

typescript/
├── packages/
│   ├── core/src/facilitator/x402Facilitator.ts    # Base orchestrator with hooks
│   └── mechanisms/aptos/src/exact/facilitator/
│       └── scheme.ts                               # Aptos verify/settle logic
└── site/app/facilitator/
    ├── index.ts           # Creates facilitator instance
    ├── verify/route.ts    # Next.js API route (thin wrapper)
    ├── settle/route.ts    # Next.js API route (thin wrapper)
    └── supported/route.ts
```

### Key Differences

| Feature | Official x402 (`github.com/aptos-labs/x402`) | This Repo |
|---------|-----------------------------------------------|-----------|
| **Scheme Registration** | `facilitator.register("aptos:2", new ExactAptosScheme(signer))` | Hardcoded in functions |
| **Network Matching** | Dynamic CAIP pattern matching (`aptos:*`) | Hardcoded `aptos:2` |
| **Signer Abstraction** | `FacilitatorAptosSigner` interface | Direct `Account` usage |
| **Hooks** | Before/after verify & settle, failure recovery | None |
| **Extensions** | Supported via `registerExtension()` | Not supported |
| **V1 Compatibility** | `registerV1()` for legacy clients | Not supported |

### Verification Logic (Nearly Identical)

Both implementations validate the same things in the same order:

1. Scheme is "exact"
2. Network matches requirements
3. Transaction calls `0x1::primary_fungible_store::transfer`
4. Type arguments length = 1 (Metadata type)
5. Function arguments = 3 (asset, recipient, amount)
6. Asset address matches
7. Recipient address matches
8. Amount matches
9. Transaction simulation succeeds

### Verify Called Inside Settle (Both Implementations)

Both call verify internally when settling:

**Official x402** (from `github.com/aptos-labs/x402`, `packages/mechanisms/aptos/src/exact/facilitator/scheme.ts:233`):
```typescript
const valid = await this.verify(payload, requirements);
if (!valid.isValid) { return { success: false, ... }; }
```

**This repo** (`facilitator.js:187`):
```javascript
const verifyResult = await verifyPayment(paymentPayload, paymentRequirements);
if (!verifyResult.isValid) { return { success: false, ... }; }
```

This means `/verify` is technically optional if you always call `/settle`.

### When to Use Which

**Use this repo when:**
- Learning how x402 works
- Building a simple Aptos-only integration
- Prototyping or hackathons
- You want to understand every line of code

**Use the official x402 (`github.com/aptos-labs/x402`) when:**
- Building production systems
- You need hooks for logging, rate limiting, or custom validation
- You want TypeScript type safety
- You need protocol extensions or V1 compatibility
