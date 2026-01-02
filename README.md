# Solana: Retro Games Onchain

A project that stores retro game files (DOS, Game Boy, NES, and other classic games) on the Solana blockchain using a cartridge-based architecture. Games are stored as cartridges with catalog entries, allowing versioning and discovery. Anyone can browse the catalog, load cartridges, and play games using emulators like DOSBox, binjgb, or other browser-based emulators.

> **Note:** This project was migrated from Nimiq to Solana. The cartridge format (ZIP with `run.json`) remains identical.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Solana Blockchain                            │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │ CatalogRoot  │───▶│ CatalogPage  │    │ CartridgeManifest    │  │
│  │   (PDA)      │    │    (PDA)     │    │      (PDA)           │  │
│  │ admin        │    │ entries[]    │───▶│ cartridge_id         │  │
│  │ total_carts  │    │              │    │ zip_size, sha256     │  │
│  │ page_count   │    └──────────────┘    │ chunk_size, chunks   │  │
│  └──────────────┘                        └──────────┬───────────┘  │
│                                                     │              │
│                                          ┌─────────────────────┐   │
│                                          │  CartridgeChunk[]   │   │
│                                          │      (PDAs)         │   │
│                                          │  chunk 0, 1, 2...   │   │
│                                          │  raw bytes (128KB)  │   │
│                                          └─────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

**Key Features:**
- ✅ **No Backend Required** - Frontend connects directly to Solana RPC endpoints
- ✅ **Static Hosting** - Perfect for GitHub Pages, Netlify, Vercel, etc.
- ✅ **Browser-Based** - All file reconstruction happens client-side
- ✅ **Catalog System** - On-chain catalog accounts for game discovery
- ✅ **Content-Addressed** - Cartridge IDs are SHA256 hashes of content
- ✅ **Platform Support** - DOS, Game Boy, Game Boy Color, NES, and more

## Project Structure

```
solana-retro/
├── program/          # Solana program (Anchor)
├── sdk/              # TypeScript SDK
├── cli/              # Command-line tool
├── web/              # Vue.js frontend
└── SOLANA_README.md  # Detailed documentation
```

## Quick Start

### Prerequisites

- Node.js 18+
- Rust & Cargo (for program)
- Solana CLI
- Anchor CLI

### 1. Setup Solana

```bash
# Install Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/v1.17.0/install)"

# Configure for devnet
solana config set --url devnet

# Create keypair and get SOL
solana-keygen new
solana airdrop 5
```

### 2. Run Frontend

```bash
cd web
npm install
npm run dev
```

Access at `http://localhost:5173`

### 3. Deploy Program (Optional)

```bash
cd program
anchor build
anchor deploy --provider.cluster devnet
```

### 4. Publish Games

```bash
cd cli
npm install
npm run dev -- publish game.zip --network devnet
```

## Documentation

See **[SOLANA_README.md](SOLANA_README.md)** for complete documentation including:

- Account model and PDA derivation
- SDK usage examples
- CLI commands
- Cost estimates
- Deployment instructions

## Cartridge Format

Games are stored as ZIP files containing:

```
game.zip
├── run.json          ← Configuration file
├── GAME.EXE          ← For DOS games
├── game.gb           ← For Game Boy games
├── game.nes          ← For NES games
└── ...               ← Additional files
```

### run.json Example

```json
{
  "title": "Commander Keen",
  "filename": "keen.zip",
  "executable": "KEEN.EXE",
  "platform": "DOS"
}
```

Supported platforms: `DOS`, `GB`, `GBC`, `NES`

See [RUN_JSON.md](RUN_JSON.md) for complete format documentation.

## SDK Usage

```typescript
import { CartridgeClient } from '@solana-retro/sdk';

const client = new CartridgeClient('devnet');

// List cartridges
const { entries } = await client.listCartridges();

// Fetch cartridge
const { zipBytes } = await client.fetchCartridgeBytes(cartridgeId);

// Publish (requires keypair)
await client.publishCartridge(keypair, zipBytes);
```

## CLI Commands

```bash
# List cartridges
cartridge-cli list --network devnet

# Get cartridge info
cartridge-cli info <cartridge-id>

# Publish a game
cartridge-cli publish game.zip --network devnet

# Get SOL airdrop
cartridge-cli airdrop --network devnet

# Check balance
cartridge-cli balance
```

## Platform Codes

| Code | Platform | Description |
|------|----------|-------------|
| `0` / `DOS` | DOS | MS-DOS games (uses JS-DOS/DOSBox) |
| `1` / `GB` | Game Boy | Game Boy games (uses binjgb) |
| `2` / `GBC` | Game Boy Color | GBC games (uses binjgb) |
| `3` / `NES` | NES | Nintendo games |

## Development

### Web Frontend

```bash
cd web
npm install
npm run dev
```

### SDK

```bash
cd sdk
npm install
npm test
```

### CLI

```bash
cd cli
npm install
npm run dev -- --help
```

### Program

```bash
cd program
anchor build
anchor test
```

## Migration from Nimiq

This project was migrated from Nimiq to Solana. Key differences:

| Feature | Nimiq | Solana |
|---------|-------|--------|
| Storage | Transaction data | PDA accounts |
| Chunk size | 51 bytes | 128KB |
| Discovery | Transaction scanning | Catalog accounts |
| Addressing | Nimiq addresses | PDAs (deterministic) |

The cartridge format (ZIP with `run.json`) is **unchanged** - existing game packages work without modification.

## ⚠️ Legal Disclaimer

**This project is for educational and research purposes only.**

- Users are responsible for ensuring they have the legal right to use any game files
- Only use games you legally own or that are in the public domain
- The developers do not condone piracy and are not responsible for any misuse of this software
- Game assets are **not included** - users must provide their own legally obtained copies
- This software is provided "as is" without warranty of any kind, express or implied

By using this software, you agree to comply with all applicable laws and regulations regarding intellectual property and copyright.

## License

MIT License - See [LICENSE](LICENSE) for details.

---

For detailed documentation, see **[SOLANA_README.md](SOLANA_README.md)**.
