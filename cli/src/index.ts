#!/usr/bin/env node

import { Command } from 'commander';
import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';

// Import from SDK package
import {
  PROGRAM_ID,
  DEFAULT_CHUNK_SIZE,
  MAX_CARTRIDGE_SIZE,
  ENTRIES_PER_PAGE,
  deriveCatalogRootPDA,
  deriveCatalogPagePDA,
  deriveManifestPDA,
  deriveChunkPDA,
  decodeCatalogRoot,
  decodeCatalogPage,
  decodeCartridgeManifest,
  sha256,
  bytesToHex,
  hexToBytes,
  formatBytes,
  CartridgeClient,
} from '@solana-retro/sdk';

const ENDPOINTS = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  localnet: 'http://localhost:8899',
};

// Helper to create ASCII progress bar
function createProgressBar(current: number, total: number, width: number): string {
  const percent = total > 0 ? current / total : 0;
  const filled = Math.round(width * percent);
  const empty = width - filled;
  const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
  return `[${bar}]`;
}

const program = new Command();

program
  .name('cartridge-cli')
  .description('CLI for managing on-chain game cartridges on Solana')
  .version('1.0.0');

// Global options
program
  .option('-n, --network <network>', 'Solana network (mainnet, devnet, testnet, localnet)', 'devnet')
  .option('-u, --url <url>', 'Custom RPC URL (overrides --network)')
  .option('-w, --ws-url <url>', 'Custom WebSocket URL (for providers with separate WS endpoints)')
  .option('-k, --keypair <path>', 'Path to keypair file', '~/.config/solana/id.json');

/**
 * Get connection based on options
 */
function getConnection(options: { network?: string; url?: string }): Connection {
  const url = options.url || ENDPOINTS[options.network as keyof typeof ENDPOINTS] || ENDPOINTS.devnet;
  return new Connection(url, 'confirmed');
}

/**
 * Load keypair from file
 */
function loadKeypair(keypairPath: string): Keypair {
  const expandedPath = keypairPath.replace('~', process.env.HOME || '');
  const secretKey = JSON.parse(fs.readFileSync(expandedPath, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

// =============================================================================
// LIST command
// =============================================================================
program
  .command('list')
  .description('List all cartridges in the catalog')
  .option('-p, --page <index>', 'Page index', '0')
  .option('--all', 'List all pages')
  .option('--include-retired', 'Include retired cartridges')
  .action(async (cmdOptions) => {
    const globalOptions = program.opts();
    const connection = getConnection(globalOptions);
    
    const spinner = ora('Fetching catalog...').start();
    
    try {
      // Get catalog root
      const [catalogRootPDA] = deriveCatalogRootPDA(PROGRAM_ID);
      const rootInfo = await connection.getAccountInfo(catalogRootPDA);
      
      if (!rootInfo) {
        spinner.fail('Catalog not initialized');
        console.log(chalk.yellow('\nTo initialize the catalog, run: cartridge-cli init'));
        return;
      }
      
      const catalogRoot = decodeCatalogRoot(rootInfo.data);
      
      spinner.succeed(`Catalog found: ${catalogRoot.totalCartridges} cartridges in ${catalogRoot.pageCount} pages`);
      
      console.log(chalk.cyan('\n═══════════════════════════════════════════════════════════════'));
      console.log(chalk.cyan('                    CARTRIDGE CATALOG'));
      console.log(chalk.cyan('═══════════════════════════════════════════════════════════════\n'));
      
      console.log(`${chalk.gray('Admin:')}          ${catalogRoot.admin.toBase58()}`);
      console.log(`${chalk.gray('Total:')}          ${catalogRoot.totalCartridges}`);
      console.log(`${chalk.gray('Pages:')}          ${catalogRoot.pageCount}`);
      console.log(`${chalk.gray('Latest Page:')}    ${catalogRoot.latestPageIndex}`);
      console.log();
      
      // Fetch pages
      const startPage = cmdOptions.all ? 0 : parseInt(cmdOptions.page);
      const endPage = cmdOptions.all ? catalogRoot.pageCount : startPage + 1;
      
      for (let pageIdx = startPage; pageIdx < endPage; pageIdx++) {
        const [pagePDA] = deriveCatalogPagePDA(pageIdx, PROGRAM_ID);
        const pageInfo = await connection.getAccountInfo(pagePDA);
        
        if (!pageInfo) {
          console.log(chalk.yellow(`Page ${pageIdx} not found`));
          continue;
        }
        
        const page = decodeCatalogPage(pageInfo.data);
        
        console.log(chalk.blue(`\n─── Page ${pageIdx} (${page.entryCount} entries) ───\n`));
        
        for (let i = 0; i < page.entryCount; i++) {
          const entry = page.entries[i];
          const isRetired = (entry.flags & 0x01) !== 0;
          
          if (isRetired && !cmdOptions.includeRetired) continue;
          
          const idHex = bytesToHex(entry.cartridgeId).substring(0, 16) + '...';
          const sizeStr = formatBytes(Number(entry.zipSize));
          const retiredStr = isRetired ? chalk.red(' [RETIRED]') : '';
          
          console.log(`  ${chalk.green(String(i + 1).padStart(2, ' '))}. ${chalk.white(idHex)}${retiredStr}`);
          console.log(`      ${chalk.gray('Size:')} ${sizeStr}  ${chalk.gray('Slot:')} ${entry.createdSlot}`);
          console.log(`      ${chalk.gray('Manifest:')} ${entry.manifestPubkey.toBase58()}`);
        }
      }
      
      if (!cmdOptions.all && catalogRoot.pageCount > 1) {
        console.log(chalk.gray(`\nUse --all to list all pages or --page <index> to specify a page`));
      }
      
    } catch (error: any) {
      spinner.fail('Failed to fetch catalog');
      console.error(chalk.red(error.message));
    }
  });

// =============================================================================
// INFO command
// =============================================================================
program
  .command('info <cartridgeId>')
  .description('Get detailed info about a cartridge')
  .action(async (cartridgeId: string) => {
    const globalOptions = program.opts();
    const connection = getConnection(globalOptions);
    
    const spinner = ora('Fetching cartridge info...').start();
    
    try {
      const idBytes = hexToBytes(cartridgeId);
      const [manifestPDA] = deriveManifestPDA(idBytes, PROGRAM_ID);
      
      const manifestInfo = await connection.getAccountInfo(manifestPDA);
      
      if (!manifestInfo) {
        spinner.fail('Cartridge not found');
        return;
      }
      
      const manifest = decodeCartridgeManifest(manifestInfo.data);
      
      spinner.succeed('Cartridge found');
      
      console.log(chalk.cyan('\n═══════════════════════════════════════════════════════════════'));
      console.log(chalk.cyan('                    CARTRIDGE INFO'));
      console.log(chalk.cyan('═══════════════════════════════════════════════════════════════\n'));
      
      console.log(`${chalk.gray('ID:')}              ${bytesToHex(manifest.cartridgeId)}`);
      console.log(`${chalk.gray('Size:')}            ${formatBytes(Number(manifest.zipSize))}`);
      console.log(`${chalk.gray('Chunk Size:')}      ${formatBytes(manifest.chunkSize)}`);
      console.log(`${chalk.gray('Num Chunks:')}      ${manifest.numChunks}`);
      console.log(`${chalk.gray('SHA256:')}          ${bytesToHex(manifest.sha256)}`);
      console.log(`${chalk.gray('Finalized:')}       ${manifest.finalized ? chalk.green('Yes') : chalk.yellow('No')}`);
      console.log(`${chalk.gray('Created Slot:')}    ${manifest.createdSlot}`);
      console.log(`${chalk.gray('Publisher:')}       ${manifest.publisher.toBase58()}`);
      console.log(`${chalk.gray('Manifest PDA:')}    ${manifestPDA.toBase58()}`);
      
      if (manifest.metadataLen > 0) {
        const metadataStr = new TextDecoder().decode(manifest.metadata.slice(0, manifest.metadataLen));
        console.log(`${chalk.gray('Metadata:')}        ${metadataStr}`);
      }
      
      // List chunk PDAs
      console.log(chalk.blue('\n─── Chunk PDAs ───\n'));
      for (let i = 0; i < Math.min(manifest.numChunks, 5); i++) {
        const [chunkPDA] = deriveChunkPDA(idBytes, i, PROGRAM_ID);
        console.log(`  Chunk ${i}: ${chunkPDA.toBase58()}`);
      }
      if (manifest.numChunks > 5) {
        console.log(`  ... and ${manifest.numChunks - 5} more chunks`);
      }
      
    } catch (error: any) {
      spinner.fail('Failed to fetch cartridge info');
      console.error(chalk.red(error.message));
    }
  });

// =============================================================================
// PUBLISH command
// =============================================================================
program
  .command('publish <zipFile>')
  .description('Publish a cartridge ZIP file to the blockchain')
  .option('-c, --chunk-size <bytes>', 'Chunk size in bytes', String(DEFAULT_CHUNK_SIZE))
  .option('-m, --metadata <json>', 'Optional metadata JSON string')
  .option('--dry-run', 'Calculate costs without publishing')
  .action(async (zipFile: string, cmdOptions) => {
    const globalOptions = program.opts();
    const connection = getConnection(globalOptions);
    
    const spinner = ora('Reading ZIP file...').start();
    
    try {
      // Read ZIP file
      const zipPath = path.resolve(zipFile);
      if (!fs.existsSync(zipPath)) {
        spinner.fail(`File not found: ${zipPath}`);
        return;
      }
      
      const zipBytes = new Uint8Array(fs.readFileSync(zipPath));
      const chunkSize = parseInt(cmdOptions.chunkSize);
      
      spinner.text = 'Computing cartridge ID...';
      
      // Compute cartridge ID (sha256)
      const cartridgeId = await sha256(zipBytes);
      const cartridgeIdHex = bytesToHex(cartridgeId);
      
      const numChunks = Math.ceil(zipBytes.length / chunkSize);
      
      spinner.succeed('ZIP file processed');
      
      console.log(chalk.cyan('\n═══════════════════════════════════════════════════════════════'));
      console.log(chalk.cyan('                    PUBLISH CARTRIDGE'));
      console.log(chalk.cyan('═══════════════════════════════════════════════════════════════\n'));
      
      console.log(`${chalk.gray('File:')}            ${path.basename(zipPath)}`);
      console.log(`${chalk.gray('Size:')}            ${formatBytes(zipBytes.length)}`);
      console.log(`${chalk.gray('Chunk Size:')}      ${formatBytes(chunkSize)}`);
      console.log(`${chalk.gray('Num Chunks:')}      ${numChunks}`);
      console.log(`${chalk.gray('Cartridge ID:')}    ${cartridgeIdHex}`);
      
      // Check if size is valid
      if (zipBytes.length > MAX_CARTRIDGE_SIZE) {
        console.log(chalk.red(`\n⚠ File too large! Maximum size is ${formatBytes(MAX_CARTRIDGE_SIZE)}`));
        return;
      }
      
      // Estimate costs
      spinner.start('Estimating costs...');
      
      const manifestSize = 8 + 32 + 8 + 4 + 4 + 32 + 1 + 8 + 32 + 2 + 1 + 256 + 16;
      const chunkAccountSize = 8 + 32 + 4 + 4 + 1 + 1 + 4 + chunkSize + 32;
      
      const manifestRent = await connection.getMinimumBalanceForRentExemption(manifestSize);
      const chunkRent = await connection.getMinimumBalanceForRentExemption(chunkAccountSize);
      const totalRent = manifestRent + (chunkRent * numChunks);
      
      // Estimate transaction fees (rough estimate)
      const txFees = (numChunks + 2) * 5000; // ~5000 lamports per tx
      
      spinner.succeed('Cost estimation complete');
      
      console.log(chalk.blue('\n─── Cost Estimate ───\n'));
      console.log(`${chalk.gray('Manifest Rent:')}   ${(manifestRent / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      console.log(`${chalk.gray('Chunk Rent:')}      ${(chunkRent / LAMPORTS_PER_SOL).toFixed(6)} SOL × ${numChunks} = ${((chunkRent * numChunks) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      console.log(`${chalk.gray('Total Rent:')}      ${(totalRent / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      console.log(`${chalk.gray('Est. Tx Fees:')}    ${(txFees / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
      console.log(chalk.yellow(`\n${chalk.bold('Total Cost:')}      ~${((totalRent + txFees) / LAMPORTS_PER_SOL).toFixed(4)} SOL`));
      
      if (cmdOptions.dryRun) {
        console.log(chalk.gray('\n[Dry run - no transactions sent]'));
        return;
      }
      
      // Load keypair
      const keypair = loadKeypair(globalOptions.keypair);
      console.log(`\n${chalk.gray('Publisher:')}       ${keypair.publicKey.toBase58()}`);
      
      // Check balance
      const balance = await connection.getBalance(keypair.publicKey);
      console.log(`${chalk.gray('Balance:')}          ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      
      if (balance < totalRent + txFees) {
        console.log(chalk.red('\n⚠ Insufficient balance!'));
        console.log(chalk.yellow(`Need at least ${((totalRent + txFees) / LAMPORTS_PER_SOL).toFixed(4)} SOL`));
        console.log(chalk.gray('\nTo get devnet SOL, run: cartridge-cli airdrop'));
        return;
      }
      
      // Check if cartridge already exists
      const [manifestPDA] = deriveManifestPDA(cartridgeId, PROGRAM_ID);
      const existingManifest = await connection.getAccountInfo(manifestPDA);
      
      if (existingManifest) {
        const manifest = decodeCartridgeManifest(existingManifest.data);
        if (manifest.finalized) {
          console.log(chalk.yellow('\n⚠ Cartridge already exists and is finalized!'));
          return;
        }
        console.log(chalk.yellow('\n⚠ Cartridge manifest exists but is not finalized. Continuing...'));
      }
      
      console.log(chalk.green('\n🚀 Starting publish...\n'));
      
      // Create client with optional WebSocket URL
      const client = new CartridgeClient(
        globalOptions.url || globalOptions.network,
        undefined, // use default program ID
        globalOptions.wsUrl
      );
      
      let lastProgressLine = '';
      const startTime = Date.now();
      
      // Publish the cartridge
      const result = await client.publishCartridge(keypair, zipBytes, {
        chunkSize,
        metadata: cmdOptions.metadata ? JSON.parse(cmdOptions.metadata) : {},
        onProgress: (progress) => {
          switch (progress.phase) {
            case 'preparing':
              spinner.text = 'Preparing cartridge...';
              break;
            case 'manifest':
              spinner.text = 'Creating manifest...';
              break;
            case 'chunks':
              // Stop spinner for chunk progress to avoid flickering
              if (spinner.isSpinning) {
                spinner.stop();
              }
              const percent = ((progress.chunksWritten / progress.totalChunks) * 100).toFixed(1);
              const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
              const rate = progress.chunksWritten > 0 ? (progress.chunksWritten / ((Date.now() - startTime) / 1000)).toFixed(1) : '0';
              const eta = progress.chunksWritten > 0 
                ? Math.ceil((progress.totalChunks - progress.chunksWritten) / (progress.chunksWritten / ((Date.now() - startTime) / 1000)))
                : '--';
              
              const progressBar = createProgressBar(progress.chunksWritten, progress.totalChunks, 30);
              const line = `\r${chalk.cyan('  ⬆')} ${progressBar} ${chalk.yellow(percent + '%')} ${chalk.gray(`[${progress.chunksWritten}/${progress.totalChunks}]`)} ${chalk.gray(`${elapsed}s elapsed, ~${eta}s remaining, ${rate} tx/s`)}`;
              
              // Use process.stdout.write for in-place updates
              process.stdout.write(line);
              lastProgressLine = line;
              break;
            case 'finalizing':
              if (lastProgressLine) {
                process.stdout.write('\n'); // New line after progress bar
              }
              spinner.start();
              spinner.text = 'Finalizing cartridge...';
              break;
            case 'complete':
              spinner.succeed('Cartridge published!');
              break;
          }
        },
      });
      
      if (result.alreadyExists) {
        spinner.warn('Cartridge already exists');
      }
      
      console.log(chalk.cyan('\n═══════════════════════════════════════════════════════════════'));
      console.log(chalk.cyan('                    PUBLISH COMPLETE'));
      console.log(chalk.cyan('═══════════════════════════════════════════════════════════════\n'));
      
      console.log(`${chalk.gray('Cartridge ID:')} ${result.cartridgeIdHex}`);
      console.log(`${chalk.gray('Manifest PDA:')} ${result.manifestPubkey.toBase58()}`);
      console.log(`${chalk.gray('Transactions:')} ${result.signatures.length}`);
      
      if (result.signatures.length > 0) {
        console.log(`\n${chalk.gray('First signature:')} ${result.signatures[0]}`);
        console.log(`${chalk.gray('Last signature:')}  ${result.signatures[result.signatures.length - 1]}`);
      }
      
    } catch (error: any) {
      spinner.fail('Failed to publish cartridge');
      console.error(chalk.red(error.message));
      if (error.logs) {
        console.error(chalk.gray('\nProgram logs:'));
        error.logs.forEach((log: string) => console.error(chalk.gray(`  ${log}`)));
      }
    }
  });

// =============================================================================
// INIT command (initialize catalog)
// =============================================================================
program
  .command('init')
  .description('Initialize the catalog (admin only, one-time setup)')
  .option('--create-page', 'Also create the first catalog page')
  .action(async (cmdOptions) => {
    const globalOptions = program.opts();
    const client = new CartridgeClient(
      globalOptions.url || globalOptions.network,
      undefined,
      globalOptions.wsUrl
    );
    
    const spinner = ora('Checking catalog status...').start();
    
    try {
      // Check if already initialized
      const existingRoot = await client.getCatalogRoot();
      
      if (existingRoot) {
        spinner.warn('Catalog already initialized');
        console.log(`\n${chalk.gray('Admin:')}      ${existingRoot.admin.toBase58()}`);
        console.log(`${chalk.gray('Cartridges:')} ${existingRoot.totalCartridges}`);
        console.log(`${chalk.gray('Pages:')}      ${existingRoot.pageCount}`);
        
        // Check if we need to create the first page
        if (existingRoot.pageCount === 0 && cmdOptions.createPage) {
          const keypair = loadKeypair(globalOptions.keypair);
          spinner.start('Creating first catalog page...');
          const sig = await client.createCatalogPage(keypair, 0);
          spinner.succeed('Created catalog page 0');
          console.log(`${chalk.gray('Signature:')} ${sig}`);
        } else if (existingRoot.pageCount === 0) {
          console.log(chalk.yellow('\n⚠ No catalog pages exist. Run with --create-page to create page 0'));
        }
        return;
      }
      
      // Load keypair
      const keypair = loadKeypair(globalOptions.keypair);
      console.log(`\n${chalk.gray('Admin:')} ${keypair.publicKey.toBase58()}`);
      
      // Check balance
      const balance = await client.getBalance(keypair.publicKey);
      console.log(`${chalk.gray('Balance:')} ${balance.toFixed(4)} SOL`);
      
      if (balance < 0.01) {
        spinner.fail('Insufficient balance');
        console.log(chalk.yellow('\nNeed at least 0.01 SOL. Run: cartridge-cli airdrop'));
        return;
      }
      
      spinner.text = 'Initializing catalog...';
      
      const signature = await client.initializeCatalog(keypair);
      spinner.succeed('Catalog initialized!');
      console.log(`\n${chalk.gray('Signature:')} ${signature}`);
      
      // Optionally create first page
      if (cmdOptions.createPage) {
        spinner.start('Creating first catalog page...');
        const pageSig = await client.createCatalogPage(keypair, 0);
        spinner.succeed('Created catalog page 0');
        console.log(`${chalk.gray('Signature:')} ${pageSig}`);
      } else {
        console.log(chalk.yellow('\nNote: Run with --create-page to also create the first catalog page'));
      }
      
    } catch (error: any) {
      spinner.fail('Failed to initialize catalog');
      console.error(chalk.red(error.message));
      if (error.logs) {
        console.error(chalk.gray('\nProgram logs:'));
        error.logs.forEach((log: string) => console.error(chalk.gray(`  ${log}`)));
      }
    }
  });

// =============================================================================
// AIRDROP command (devnet/testnet only)
// =============================================================================
program
  .command('airdrop')
  .description('Request SOL airdrop (devnet/testnet only)')
  .option('-a, --amount <sol>', 'Amount of SOL to request', '2')
  .action(async (cmdOptions) => {
    const globalOptions = program.opts();
    const connection = getConnection(globalOptions);
    
    const spinner = ora('Requesting airdrop...').start();
    
    try {
      const keypair = loadKeypair(globalOptions.keypair);
      const amount = parseFloat(cmdOptions.amount);
      
      const signature = await connection.requestAirdrop(
        keypair.publicKey,
        amount * LAMPORTS_PER_SOL
      );
      
      spinner.text = 'Confirming transaction...';
      await connection.confirmTransaction(signature);
      
      const balance = await connection.getBalance(keypair.publicKey);
      
      spinner.succeed(`Airdrop successful!`);
      console.log(`\n${chalk.gray('Address:')}    ${keypair.publicKey.toBase58()}`);
      console.log(`${chalk.gray('Amount:')}     ${amount} SOL`);
      console.log(`${chalk.gray('Balance:')}    ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      console.log(`${chalk.gray('Signature:')} ${signature}`);
      
    } catch (error: any) {
      spinner.fail('Airdrop failed');
      console.error(chalk.red(error.message));
      console.log(chalk.yellow('\nNote: Airdrops only work on devnet/testnet'));
    }
  });

// =============================================================================
// BALANCE command
// =============================================================================
program
  .command('balance')
  .description('Check SOL balance')
  .option('-a, --address <pubkey>', 'Address to check (defaults to keypair)')
  .action(async (cmdOptions) => {
    const globalOptions = program.opts();
    const connection = getConnection(globalOptions);
    
    const spinner = ora('Checking balance...').start();
    
    try {
      let address: PublicKey;
      
      if (cmdOptions.address) {
        address = new PublicKey(cmdOptions.address);
      } else {
        const keypair = loadKeypair(globalOptions.keypair);
        address = keypair.publicKey;
      }
      
      const balance = await connection.getBalance(address);
      
      spinner.succeed('Balance retrieved');
      console.log(`\n${chalk.gray('Address:')} ${address.toBase58()}`);
      console.log(`${chalk.gray('Balance:')} ${chalk.green((balance / LAMPORTS_PER_SOL).toFixed(6))} SOL`);
      
    } catch (error: any) {
      spinner.fail('Failed to check balance');
      console.error(chalk.red(error.message));
    }
  });

// =============================================================================
// PDA command (derive PDAs)
// =============================================================================
program
  .command('pda')
  .description('Derive PDA addresses')
  .option('--catalog-root', 'Derive CatalogRoot PDA')
  .option('--catalog-page <index>', 'Derive CatalogPage PDA')
  .option('--manifest <cartridgeId>', 'Derive Manifest PDA')
  .option('--chunk <cartridgeId:index>', 'Derive Chunk PDA')
  .action(async (cmdOptions) => {
    console.log(chalk.cyan('\n═══════════════════════════════════════════════════════════════'));
    console.log(chalk.cyan('                    PDA DERIVATION'));
    console.log(chalk.cyan('═══════════════════════════════════════════════════════════════\n'));
    
    console.log(`${chalk.gray('Program ID:')} ${PROGRAM_ID.toBase58()}\n`);
    
    if (cmdOptions.catalogRoot || Object.keys(cmdOptions).length === 0) {
      const [pda, bump] = deriveCatalogRootPDA(PROGRAM_ID);
      console.log(`${chalk.blue('CatalogRoot PDA:')}`);
      console.log(`  Address: ${pda.toBase58()}`);
      console.log(`  Bump: ${bump}`);
      console.log(`  Seeds: ["catalog_root"]\n`);
    }
    
    if (cmdOptions.catalogPage !== undefined) {
      const pageIndex = parseInt(cmdOptions.catalogPage);
      const [pda, bump] = deriveCatalogPagePDA(pageIndex, PROGRAM_ID);
      console.log(`${chalk.blue(`CatalogPage PDA (index: ${pageIndex}):`)}`);
      console.log(`  Address: ${pda.toBase58()}`);
      console.log(`  Bump: ${bump}`);
      console.log(`  Seeds: ["catalog_page", ${pageIndex}]\n`);
    }
    
    if (cmdOptions.manifest) {
      const idBytes = hexToBytes(cmdOptions.manifest);
      const [pda, bump] = deriveManifestPDA(idBytes, PROGRAM_ID);
      console.log(`${chalk.blue('Manifest PDA:')}`);
      console.log(`  Address: ${pda.toBase58()}`);
      console.log(`  Bump: ${bump}`);
      console.log(`  Seeds: ["manifest", <cartridge_id>]\n`);
    }
    
    if (cmdOptions.chunk) {
      const [cartridgeId, indexStr] = cmdOptions.chunk.split(':');
      const idBytes = hexToBytes(cartridgeId);
      const chunkIndex = parseInt(indexStr);
      const [pda, bump] = deriveChunkPDA(idBytes, chunkIndex, PROGRAM_ID);
      console.log(`${chalk.blue(`Chunk PDA (index: ${chunkIndex}):`)}`);
      console.log(`  Address: ${pda.toBase58()}`);
      console.log(`  Bump: ${bump}`);
      console.log(`  Seeds: ["chunk", <cartridge_id>, ${chunkIndex}]\n`);
    }
  });

// Parse arguments
program.parse();

