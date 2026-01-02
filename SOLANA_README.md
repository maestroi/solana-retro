# Solana Retro - On-Chain Game Cartridge Storage

This project implements on-chain storage for game cartridges (ROMs) on Solana, migrated from a Nimiq implementation. The cartridge format remains identical: ZIP files containing `run.json` and game assets.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Solana Blockchain                            │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │ CatalogRoot  │───▶│ CatalogPage  │    │ CartridgeManifest    │  │
│  │   (PDA)      │    │    (PDA)     │    │      (PDA)           │  │
│  │              │    │ entries[]    │───▶│ cartridge_id         │  │
│  │ admin        │    │              │    │ zip_size, sha256     │  │
│  │ total_carts  │    └──────────────┘    │ chunk_size, num_chunks│  │
│  │ page_count   │                        └──────────┬───────────┘  │
│  └──────────────┘                                   │              │
│                                                     ▼              │
│                                          ┌─────────────────────┐   │
│                                          │  CartridgeChunk[]   │   │
│                                          │      (PDAs)         │   │
│                                          │  chunk 0, 1, 2...   │   │
│                                          │  raw bytes (128KB)  │   │
│                                          └─────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Solana Program (`/program`)

An Anchor-based Solana program that manages:

- **CatalogRoot**: Global catalog metadata (admin, counts, page tracking)
- **CatalogPage**: Pages of cartridge entries for discovery (32 entries per page)
- **CartridgeManifest**: Metadata for each cartridge (size, chunks, hash, etc.)
- **CartridgeChunk**: Raw data chunks (default 128KB each)

**Key Features:**
- Content-addressed cartridge IDs (SHA256 of ZIP bytes)
- Chunked storage for large files (up to 6MB)
- Immutable cartridges once finalized
- No transaction history scanning required for discovery

### 2. TypeScript SDK (`/sdk`)

A TypeScript SDK for interacting with the program:

```typescript
import { CartridgeClient } from '@solana-retro/sdk';

// Initialize client
const client = new CartridgeClient('devnet');

// List cartridges
const { entries, totalCartridges } = await client.listCartridges();

// Fetch cartridge bytes
const { zipBytes, manifest, verified } = await client.fetchCartridgeBytes(cartridgeId);

// Publish cartridge (requires wallet)
const result = await client.publishCartridge(keypair, zipBytes, {
  onProgress: (p) => console.log(`${p.chunksWritten}/${p.totalChunks} chunks`)
});
```

### 3. CLI (`/cli`)

Command-line tool for managing cartridges:

```bash
# List all cartridges
cartridge-cli list --network devnet

# Get cartridge info
cartridge-cli info <cartridge-id>

# Publish a cartridge
cartridge-cli publish game.zip --network devnet

# Request SOL airdrop (devnet/testnet)
cartridge-cli airdrop

# Check balance
cartridge-cli balance

# Derive PDAs
cartridge-cli pda --catalog-root
```

### 4. Web Frontend (`/web`)

Vue.js frontend with Solana integration composables:

- `useSolanaCatalog.js` - Load catalog entries
- `useSolanaCartridge.js` - Load individual cartridges
- `solana-rpc.js` - Low-level Solana RPC utilities

## Quick Start

### Prerequisites

- Node.js 18+
- Rust & Cargo
- Solana CLI
- Anchor CLI (for program deployment)

### 1. Setup Solana CLI

```bash
# Install Solana CLI (latest version)
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"

# Add Solana to PATH (if not already added)
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Install Solana platform tools (cargo-build-sbf)
# This is typically included with modern Solana CLI installations
# If missing, install via: cargo install cargo-build-sbf

# Configure for devnet
solana config set --url devnet

# Create a keypair (if you don't have one)
solana-keygen new

# Get devnet SOL
solana airdrop 5

# Verify platform tools are installed
cargo-build-sbf --version
solana --version
```

### 1.5. Install Anchor CLI

```bash
# Install Anchor Version Manager (avm)
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force

# Install latest Anchor version (0.32.1)
avm install latest
avm use latest

# Verify installation
anchor --version
```

Alternatively, you can install Anchor directly via cargo (not recommended for version management):
```bash
cargo install --git https://github.com/coral-xyz/anchor anchor-cli --locked
```

> **Note**: The project uses Anchor 0.32.1 (latest). The `Anchor.toml` file includes `[toolchain] anchor_version = "0.32.1"` to ensure version consistency.

### 2. Build & Deploy Program

```bash
cd program

# Install dependencies
yarn install

# Build the program
anchor build

# Deploy to testnet
anchor deploy --provider.cluster testnet

# Note the program ID and update if different from default
```

### 3. Initialize Catalog

After deploying, initialize the catalog (one-time admin action):

```bash
cd cli
npm install
npm run dev -- init --network devnet
```

Or using the SDK:

```typescript
import { CartridgeClient } from '@solana-retro/sdk';
import { Keypair } from '@solana/web3.js';

const client = new CartridgeClient('devnet');
const adminKeypair = Keypair.fromSecretKey(/* your secret key */);

await client.initializeCatalog(adminKeypair);
await client.createCatalogPage(adminKeypair, 0); // Create first page
```

### 4. Publish a Cartridge

```bash
# Using CLI
cd cli
npm run dev -- publish /path/to/game.zip --network devnet

# Or using SDK
const zipBytes = fs.readFileSync('game.zip');
const result = await client.publishCartridge(keypair, zipBytes);
console.log('Cartridge ID:', result.cartridgeIdHex);
```

### 5. Run Frontend

```bash
cd web
npm install
npm run dev
```

## Account Model

### PDA Seeds

| Account | Seeds | Description |
|---------|-------|-------------|
| CatalogRoot | `["catalog_root"]` | Global catalog metadata |
| CatalogPage | `["catalog_page", u32 page_index]` | Page of cartridge entries |
| CartridgeManifest | `["manifest", cartridge_id]` | Cartridge metadata |
| CartridgeChunk | `["chunk", cartridge_id, u32 chunk_index]` | Raw data chunk |

### Account Sizes

| Account | Size | Rent (approx) |
|---------|------|---------------|
| CatalogRoot | ~74 bytes | 0.001 SOL |
| CatalogPage | ~3,880 bytes | 0.027 SOL |
| CartridgeManifest | ~410 bytes | 0.003 SOL |
| CartridgeChunk (128KB) | ~131KB | 0.92 SOL |

### Cost Estimation

For a 1MB cartridge with 128KB chunks (8 chunks):
- Manifest: ~0.003 SOL
- Chunks: 8 × 0.92 SOL = ~7.36 SOL
- Transaction fees: ~0.001 SOL
- **Total: ~7.4 SOL**

For a 6MB cartridge (48 chunks):
- **Total: ~44 SOL**

> Note: These are rent-exempt deposits, not fees. The SOL is recoverable if accounts are closed.

## Configuration

### Program ID

The default program ID is:
```
CartS1QpBgPfpgq4RpPpXVuvN4SrJvYNXBfW9D1Rmvp
```

To use a different program ID, update:
1. `program/programs/cartridge-storage/src/lib.rs` - `declare_id!`
2. `sdk/src/constants.ts` - `PROGRAM_ID`
3. `web/src/solana-rpc.js` - `PROGRAM_ID`

### Network Endpoints

```typescript
const ENDPOINTS = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  localnet: 'http://localhost:8899',
};
```

## Cartridge Format

The cartridge format is unchanged from the Nimiq implementation:

```
game.zip
├── run.json          ← Configuration file
├── GAME.EXE          ← For DOS games
├── game.gb           ← For Game Boy games  
├── game.nes          ← For NES games
└── ...               ← Additional files
```

### run.json Schema

```json
{
  "title": "Game Title",
  "filename": "game.zip",
  "executable": "GAME.EXE",
  "rom": "game.gb",
  "platform": "DOS"
}
```

Supported platforms: `DOS`, `GB`, `GBC`, `NES`

## Testing

### Run SDK Tests

```bash
cd sdk
npm install
npm test
```

### Test PDA Derivation

```bash
cd cli
npm run dev -- pda --catalog-root --catalog-page 0
```

### Local Testing with Validator

```bash
# Terminal 1: Start local validator
solana-test-validator

# Terminal 2: Deploy and test
cd program
anchor build
anchor deploy --provider.cluster localnet

cd ../cli
npm run dev -- init --network localnet
npm run dev -- list --network localnet
```

## Migration from Nimiq

The key differences from the Nimiq implementation:

1. **Storage Model**: PDAs instead of transaction data
2. **Discovery**: CatalogRoot + CatalogPage accounts instead of transaction scanning
3. **Chunks**: Separate accounts per chunk instead of embedded in transactions
4. **Content Addressing**: SHA256 of ZIP bytes as cartridge ID

### Frontend Migration

Replace Nimiq composables with Solana equivalents:

```javascript
// Before (Nimiq)
import { useCatalog } from './composables/useCatalog.js'
import { useCartridge } from './composables/useCartridge.js'

// After (Solana)
import { useSolanaCatalog } from './composables/useSolanaCatalog.js'
import { useSolanaCartridge } from './composables/useSolanaCartridge.js'
```

The interface is kept similar to minimize frontend changes.

## Security Considerations

1. **Immutability**: Chunks cannot be modified after writing
2. **Content Addressing**: Cartridge ID is SHA256 of content, preventing tampering
3. **Verification**: Clients verify SHA256 hash after reconstruction
4. **Publisher Tracking**: Each manifest stores the publisher's public key

## Troubleshooting

### "Account does not exist"
- Ensure the program is deployed to the correct network
- Initialize the catalog if not done

### "Insufficient funds"
- Request airdrop: `solana airdrop 5`
- Check balance: `cartridge-cli balance`

### "Transaction too large"
- Reduce chunk size (default 128KB may need to be smaller for some RPC providers)
- Some providers limit transaction size

### "Rate limited"
- Add delays between chunk uploads
- Use a dedicated RPC provider

## License

MIT

