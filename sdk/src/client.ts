import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  PROGRAM_ID,
  DEFAULT_CHUNK_SIZE,
  MAX_CARTRIDGE_SIZE,
  ENTRIES_PER_PAGE,
  ENDPOINTS,
  NetworkName,
} from './constants.js';
import {
  deriveCatalogRootPDA,
  deriveCatalogPagePDA,
  deriveManifestPDA,
  deriveChunkPDA,
  deriveAllChunkPDAs,
} from './pda.js';
import {
  decodeCatalogRoot,
  decodeCatalogPage,
  decodeCartridgeManifest,
  decodeCartridgeChunk,
  accountExists,
} from './decoder.js';
import {
  CatalogRoot,
  CatalogPage,
  CartridgeManifest,
  Cartridge,
  CartridgeWithData,
  ListOptions,
  ListResult,
  PublishOptions,
  PublishResult,
  FetchOptions,
  FetchProgress,
  PublishProgress,
  CatalogEntry,
} from './types.js';
import {
  sha256,
  bytesToHex,
  hexToBytes,
  splitIntoChunks,
  concatBytes,
  verifySHA256,
  batch,
  sleep,
  retry,
} from './utils.js';

/**
 * CartridgeClient - Main SDK client for interacting with the cartridge storage program
 */
export class CartridgeClient {
  public connection: Connection;
  public programId: PublicKey;

  constructor(
    connectionOrEndpoint: Connection | string | NetworkName,
    programId: PublicKey = PROGRAM_ID
  ) {
    if (connectionOrEndpoint instanceof Connection) {
      this.connection = connectionOrEndpoint;
    } else if (connectionOrEndpoint in ENDPOINTS) {
      this.connection = new Connection(ENDPOINTS[connectionOrEndpoint as NetworkName], 'confirmed');
    } else {
      this.connection = new Connection(connectionOrEndpoint, 'confirmed');
    }
    this.programId = programId;
  }

  // ==========================================================================
  // Read Operations
  // ==========================================================================

  /**
   * Get the catalog root account
   */
  async getCatalogRoot(): Promise<CatalogRoot | null> {
    const [pda] = deriveCatalogRootPDA(this.programId);
    const accountInfo = await this.connection.getAccountInfo(pda);
    
    if (!accountInfo || !accountExists(accountInfo.data)) {
      return null;
    }
    
    return decodeCatalogRoot(accountInfo.data);
  }

  /**
   * Get a catalog page by index
   */
  async getCatalogPage(pageIndex: number): Promise<CatalogPage | null> {
    const [pda] = deriveCatalogPagePDA(pageIndex, this.programId);
    const accountInfo = await this.connection.getAccountInfo(pda);
    
    if (!accountInfo || !accountExists(accountInfo.data)) {
      return null;
    }
    
    return decodeCatalogPage(accountInfo.data);
  }

  /**
   * List cartridges from the catalog
   */
  async listCartridges(options: ListOptions = {}): Promise<ListResult> {
    const catalogRoot = await this.getCatalogRoot();
    
    if (!catalogRoot) {
      return {
        entries: [],
        totalCartridges: 0n,
        pageCount: 0,
        currentPageIndex: 0,
        hasMore: false,
      };
    }
    
    const pageIndex = options.pageIndex ?? catalogRoot.latestPageIndex;
    const page = await this.getCatalogPage(pageIndex);
    
    let entries = page?.entries ?? [];
    
    // Filter out retired entries unless requested
    if (!options.includeRetired) {
      entries = entries.filter(e => (e.flags & 0x01) === 0);
    }
    
    return {
      entries,
      totalCartridges: catalogRoot.totalCartridges,
      pageCount: catalogRoot.pageCount,
      currentPageIndex: pageIndex,
      hasMore: pageIndex > 0,
    };
  }

  /**
   * List all cartridges across all pages
   */
  async listAllCartridges(options: ListOptions = {}): Promise<CatalogEntry[]> {
    const catalogRoot = await this.getCatalogRoot();
    
    if (!catalogRoot || catalogRoot.pageCount === 0) {
      return [];
    }
    
    const allEntries: CatalogEntry[] = [];
    
    // Fetch all pages in parallel
    const pagePromises: Promise<CatalogPage | null>[] = [];
    for (let i = 0; i < catalogRoot.pageCount; i++) {
      pagePromises.push(this.getCatalogPage(i));
    }
    
    const pages = await Promise.all(pagePromises);
    
    for (const page of pages) {
      if (page) {
        let entries = page.entries;
        if (!options.includeRetired) {
          entries = entries.filter(e => (e.flags & 0x01) === 0);
        }
        allEntries.push(...entries);
      }
    }
    
    return allEntries;
  }

  /**
   * Get a cartridge manifest by ID
   */
  async getManifest(cartridgeId: Uint8Array | string): Promise<CartridgeManifest | null> {
    const idBytes = typeof cartridgeId === 'string' ? hexToBytes(cartridgeId) : cartridgeId;
    const [pda] = deriveManifestPDA(idBytes, this.programId);
    const accountInfo = await this.connection.getAccountInfo(pda);
    
    if (!accountInfo || !accountExists(accountInfo.data)) {
      return null;
    }
    
    return decodeCartridgeManifest(accountInfo.data);
  }

  /**
   * Get a cartridge (manifest + basic info)
   */
  async getCartridge(cartridgeId: Uint8Array | string): Promise<Cartridge | null> {
    const idBytes = typeof cartridgeId === 'string' ? hexToBytes(cartridgeId) : cartridgeId;
    const manifest = await this.getManifest(idBytes);
    
    if (!manifest) {
      return null;
    }
    
    const [manifestPubkey] = deriveManifestPDA(idBytes, this.programId);
    
    return {
      id: bytesToHex(idBytes),
      idBytes,
      manifest,
      manifestPubkey,
    };
  }

  /**
   * Fetch cartridge with full ZIP data reconstructed
   */
  async fetchCartridgeBytes(
    cartridgeId: Uint8Array | string,
    options: FetchOptions = {}
  ): Promise<CartridgeWithData | null> {
    const idBytes = typeof cartridgeId === 'string' ? hexToBytes(cartridgeId) : cartridgeId;
    const { onProgress, verifyHash = true } = options;
    
    // Get manifest
    onProgress?.({
      phase: 'manifest',
      chunksLoaded: 0,
      totalChunks: 0,
      bytesLoaded: 0,
      totalBytes: 0,
    });
    
    const manifest = await this.getManifest(idBytes);
    if (!manifest) {
      return null;
    }
    
    const [manifestPubkey] = deriveManifestPDA(idBytes, this.programId);
    const totalBytes = Number(manifest.zipSize);
    const totalChunks = manifest.numChunks;
    
    // Derive all chunk PDAs
    const chunkPDAs = deriveAllChunkPDAs(idBytes, totalChunks, this.programId);
    
    // Fetch chunks in batches (getMultipleAccountsInfo has a limit of 100)
    const BATCH_SIZE = 100;
    const chunkBatches = batch(chunkPDAs, BATCH_SIZE);
    const chunks: (Uint8Array | null)[] = new Array(totalChunks).fill(null);
    let chunksLoaded = 0;
    let bytesLoaded = 0;
    
    onProgress?.({
      phase: 'chunks',
      chunksLoaded: 0,
      totalChunks,
      bytesLoaded: 0,
      totalBytes,
    });
    
    for (const batchPDAs of chunkBatches) {
      const pubkeys = batchPDAs.map(([pk]) => pk);
      const accountInfos = await retry(() => 
        this.connection.getMultipleAccountsInfo(pubkeys)
      );
      
      for (let i = 0; i < accountInfos.length; i++) {
        const info = accountInfos[i];
        if (info && accountExists(info.data)) {
          const chunkData = decodeCartridgeChunk(info.data);
          const globalIndex = chunkBatches.indexOf(batchPDAs) * BATCH_SIZE + i;
          chunks[globalIndex] = chunkData.data;
          chunksLoaded++;
          bytesLoaded += chunkData.data.length;
        }
      }
      
      onProgress?.({
        phase: 'chunks',
        chunksLoaded,
        totalChunks,
        bytesLoaded,
        totalBytes,
      });
    }
    
    // Check if all chunks were loaded
    const missingChunks = chunks.reduce((acc, c, i) => c === null ? [...acc, i] : acc, [] as number[]);
    if (missingChunks.length > 0) {
      throw new Error(`Missing chunks: ${missingChunks.join(', ')}`);
    }
    
    // Reconstruct ZIP bytes
    const zipBytes = concatBytes(...(chunks as Uint8Array[]));
    
    // Verify hash
    let verified = false;
    if (verifyHash) {
      onProgress?.({
        phase: 'verifying',
        chunksLoaded,
        totalChunks,
        bytesLoaded,
        totalBytes,
      });
      
      verified = await verifySHA256(zipBytes, manifest.sha256);
      if (!verified) {
        throw new Error('SHA256 verification failed');
      }
    }
    
    onProgress?.({
      phase: 'complete',
      chunksLoaded,
      totalChunks,
      bytesLoaded,
      totalBytes,
    });
    
    return {
      id: bytesToHex(idBytes),
      idBytes,
      manifest,
      manifestPubkey,
      zipBytes,
      verified,
    };
  }

  // ==========================================================================
  // Write Operations (requires wallet/keypair)
  // ==========================================================================

  /**
   * Initialize the catalog (admin only, one-time setup)
   */
  async initializeCatalog(admin: Keypair): Promise<string> {
    const [catalogRootPDA] = deriveCatalogRootPDA(this.programId);
    
    // Build instruction data: [discriminator (8 bytes)]
    // Discriminator for initialize_catalog: hash("global:initialize_catalog")[0:8]
    const discriminator = Buffer.from([175, 176, 144, 190, 173, 55, 160, 243]); // anchor discriminator
    
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: catalogRootPDA, isSigner: false, isWritable: true },
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data: discriminator,
    });
    
    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [admin]);
  }

  /**
   * Create a new catalog page (admin only)
   */
  async createCatalogPage(admin: Keypair, pageIndex: number): Promise<string> {
    const [catalogRootPDA] = deriveCatalogRootPDA(this.programId);
    const [catalogPagePDA] = deriveCatalogPagePDA(pageIndex, this.programId);
    
    // Discriminator + page_index (u32 LE)
    const discriminator = Buffer.from([183, 149, 12, 91, 187, 130, 85, 215]);
    const data = Buffer.alloc(12);
    discriminator.copy(data);
    data.writeUInt32LE(pageIndex, 8);
    
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: catalogRootPDA, isSigner: false, isWritable: true },
        { pubkey: catalogPagePDA, isSigner: false, isWritable: true },
        { pubkey: admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data,
    });
    
    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [admin]);
  }

  /**
   * Publish a cartridge (ZIP bytes) to the blockchain
   */
  async publishCartridge(
    publisher: Keypair,
    zipBytes: Uint8Array,
    options: PublishOptions = {}
  ): Promise<PublishResult> {
    const {
      chunkSize = DEFAULT_CHUNK_SIZE,
      metadata = {},
      onProgress,
      skipExisting = true,
    } = options;
    
    // Validate size
    if (zipBytes.length > MAX_CARTRIDGE_SIZE) {
      throw new Error(`Cartridge size ${zipBytes.length} exceeds maximum ${MAX_CARTRIDGE_SIZE}`);
    }
    
    // Compute cartridge ID (sha256 of ZIP)
    const cartridgeId = await sha256(zipBytes);
    const cartridgeIdHex = bytesToHex(cartridgeId);
    
    onProgress?.({
      phase: 'preparing',
      chunksWritten: 0,
      totalChunks: 0,
    });
    
    // Check if already exists
    const existingManifest = await this.getManifest(cartridgeId);
    if (existingManifest) {
      if (skipExisting && existingManifest.finalized) {
        const [manifestPubkey] = deriveManifestPDA(cartridgeId, this.programId);
        return {
          cartridgeId,
          cartridgeIdHex,
          manifestPubkey,
          signatures: [],
          alreadyExists: true,
        };
      }
      throw new Error(`Cartridge ${cartridgeIdHex} already exists`);
    }
    
    // Split into chunks
    const chunks = splitIntoChunks(zipBytes, chunkSize);
    const numChunks = chunks.length;
    const metadataBytes = Buffer.from(JSON.stringify(metadata));
    
    const signatures: string[] = [];
    
    onProgress?.({
      phase: 'manifest',
      chunksWritten: 0,
      totalChunks: numChunks,
    });
    
    // Create manifest
    const manifestSig = await this.createManifest(
      publisher,
      cartridgeId,
      BigInt(zipBytes.length),
      chunkSize,
      cartridgeId, // sha256 is the same as cartridge_id
      metadataBytes
    );
    signatures.push(manifestSig);
    
    // Write chunks
    onProgress?.({
      phase: 'chunks',
      chunksWritten: 0,
      totalChunks: numChunks,
    });
    
    for (let i = 0; i < chunks.length; i++) {
      const chunkSig = await this.writeChunk(publisher, cartridgeId, i, chunks[i]);
      signatures.push(chunkSig);
      
      onProgress?.({
        phase: 'chunks',
        chunksWritten: i + 1,
        totalChunks: numChunks,
        currentTx: chunkSig,
      });
      
      // Small delay between chunks to avoid rate limiting
      if (i < chunks.length - 1) {
        await sleep(100);
      }
    }
    
    // Finalize
    onProgress?.({
      phase: 'finalizing',
      chunksWritten: numChunks,
      totalChunks: numChunks,
    });
    
    const catalogRoot = await this.getCatalogRoot();
    if (!catalogRoot) {
      throw new Error('Catalog not initialized');
    }
    
    // Check if current page has room
    const currentPage = await this.getCatalogPage(catalogRoot.latestPageIndex);
    let pageIndex = catalogRoot.latestPageIndex;
    
    if (!currentPage || currentPage.entryCount >= ENTRIES_PER_PAGE) {
      // Need to create a new page (requires admin)
      throw new Error('Current catalog page is full. Admin needs to create a new page.');
    }
    
    const finalizeSig = await this.finalizeCartridge(publisher, cartridgeId, pageIndex);
    signatures.push(finalizeSig);
    
    onProgress?.({
      phase: 'complete',
      chunksWritten: numChunks,
      totalChunks: numChunks,
    });
    
    const [manifestPubkey] = deriveManifestPDA(cartridgeId, this.programId);
    
    return {
      cartridgeId,
      cartridgeIdHex,
      manifestPubkey,
      signatures,
    };
  }

  /**
   * Create a manifest (internal)
   */
  private async createManifest(
    publisher: Keypair,
    cartridgeId: Uint8Array,
    zipSize: bigint,
    chunkSize: number,
    sha256Hash: Uint8Array,
    metadata: Buffer
  ): Promise<string> {
    const [manifestPDA] = deriveManifestPDA(cartridgeId, this.programId);
    
    // Build instruction data
    const discriminator = Buffer.from([220, 174, 193, 148, 200, 228, 66, 67]);
    
    // Calculate data size
    const dataSize = 8 + 32 + 8 + 4 + 32 + 4 + metadata.length;
    const data = Buffer.alloc(dataSize);
    let offset = 0;
    
    discriminator.copy(data, offset);
    offset += 8;
    
    Buffer.from(cartridgeId).copy(data, offset);
    offset += 32;
    
    data.writeBigUInt64LE(zipSize, offset);
    offset += 8;
    
    data.writeUInt32LE(chunkSize, offset);
    offset += 4;
    
    Buffer.from(sha256Hash).copy(data, offset);
    offset += 32;
    
    // Metadata as vec (length prefix + data)
    data.writeUInt32LE(metadata.length, offset);
    offset += 4;
    metadata.copy(data, offset);
    
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: manifestPDA, isSigner: false, isWritable: true },
        { pubkey: publisher.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data,
    });
    
    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [publisher]);
  }

  /**
   * Write a chunk (internal)
   */
  private async writeChunk(
    publisher: Keypair,
    cartridgeId: Uint8Array,
    chunkIndex: number,
    chunkData: Uint8Array
  ): Promise<string> {
    const [manifestPDA] = deriveManifestPDA(cartridgeId, this.programId);
    const [chunkPDA] = deriveChunkPDA(cartridgeId, chunkIndex, this.programId);
    
    // Build instruction data
    const discriminator = Buffer.from([54, 167, 198, 40, 102, 210, 159, 225]);
    
    const dataSize = 8 + 32 + 4 + 4 + chunkData.length;
    const data = Buffer.alloc(dataSize);
    let offset = 0;
    
    discriminator.copy(data, offset);
    offset += 8;
    
    Buffer.from(cartridgeId).copy(data, offset);
    offset += 32;
    
    data.writeUInt32LE(chunkIndex, offset);
    offset += 4;
    
    // Data as vec
    data.writeUInt32LE(chunkData.length, offset);
    offset += 4;
    Buffer.from(chunkData).copy(data, offset);
    
    // Add compute budget for large chunks
    const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 400_000,
    });
    
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: manifestPDA, isSigner: false, isWritable: false },
        { pubkey: chunkPDA, isSigner: false, isWritable: true },
        { pubkey: publisher.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      programId: this.programId,
      data,
    });
    
    const tx = new Transaction().add(computeBudgetIx, ix);
    return sendAndConfirmTransaction(this.connection, tx, [publisher]);
  }

  /**
   * Finalize a cartridge (internal)
   */
  private async finalizeCartridge(
    publisher: Keypair,
    cartridgeId: Uint8Array,
    pageIndex: number
  ): Promise<string> {
    const [manifestPDA] = deriveManifestPDA(cartridgeId, this.programId);
    const [catalogRootPDA] = deriveCatalogRootPDA(this.programId);
    const [catalogPagePDA] = deriveCatalogPagePDA(pageIndex, this.programId);
    
    // Build instruction data
    const discriminator = Buffer.from([203, 156, 116, 96, 95, 125, 187, 94]);
    
    const dataSize = 8 + 32 + 4;
    const data = Buffer.alloc(dataSize);
    let offset = 0;
    
    discriminator.copy(data, offset);
    offset += 8;
    
    Buffer.from(cartridgeId).copy(data, offset);
    offset += 32;
    
    data.writeUInt32LE(pageIndex, offset);
    
    const ix = new TransactionInstruction({
      keys: [
        { pubkey: manifestPDA, isSigner: false, isWritable: true },
        { pubkey: catalogRootPDA, isSigner: false, isWritable: true },
        { pubkey: catalogPagePDA, isSigner: false, isWritable: true },
        { pubkey: publisher.publicKey, isSigner: true, isWritable: true },
      ],
      programId: this.programId,
      data,
    });
    
    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.connection, tx, [publisher]);
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Get SOL balance for an address
   */
  async getBalance(address: PublicKey | string): Promise<number> {
    const pubkey = typeof address === 'string' ? new PublicKey(address) : address;
    const lamports = await this.connection.getBalance(pubkey);
    return lamports / LAMPORTS_PER_SOL;
  }

  /**
   * Request airdrop (devnet/testnet only)
   */
  async requestAirdrop(address: PublicKey | string, amount: number = 1): Promise<string> {
    const pubkey = typeof address === 'string' ? new PublicKey(address) : address;
    const signature = await this.connection.requestAirdrop(pubkey, amount * LAMPORTS_PER_SOL);
    await this.connection.confirmTransaction(signature);
    return signature;
  }

  /**
   * Estimate rent for storing a cartridge
   */
  async estimateRent(zipSize: number, chunkSize: number = DEFAULT_CHUNK_SIZE): Promise<number> {
    const numChunks = Math.ceil(zipSize / chunkSize);
    
    // Manifest account size
    const manifestSize = 8 + 32 + 8 + 4 + 4 + 32 + 1 + 8 + 32 + 2 + 1 + 256 + 16;
    
    // Chunk account size (per chunk)
    const chunkAccountSize = 8 + 32 + 4 + 4 + 1 + 1 + 4 + chunkSize + 32;
    
    const manifestRent = await this.connection.getMinimumBalanceForRentExemption(manifestSize);
    const chunkRent = await this.connection.getMinimumBalanceForRentExemption(chunkAccountSize);
    
    const totalRent = manifestRent + (chunkRent * numChunks);
    return totalRent / LAMPORTS_PER_SOL;
  }
}

