//! Cartridge Storage Program for Solana
//! 
//! This program enables on-chain storage of game cartridges (ZIP files containing ROMs and metadata).
//! It uses a chunked storage approach to handle large files up to 6MB.
//!
//! Account Structure:
//! - CatalogRoot: Global catalog metadata (admin, counts)
//! - CatalogPage: Pages of cartridge entries for discovery
//! - CartridgeManifest: Metadata for each cartridge
//! - CartridgeChunk: Raw bytes for cartridge data chunks

use anchor_lang::prelude::*;

declare_id!("CartS1QpBgPfpgq4RpPpXVuvN4SrJvYNXBfW9D1Rmvp");

/// Maximum size of a cartridge ZIP (6MB)
pub const MAX_CARTRIDGE_SIZE: u64 = 6 * 1024 * 1024;

/// Default chunk size (128KB)
pub const DEFAULT_CHUNK_SIZE: u32 = 128 * 1024;

/// Maximum entries per catalog page
pub const ENTRIES_PER_PAGE: usize = 32;

/// Size of a catalog entry (fixed for predictable sizing)
pub const CATALOG_ENTRY_SIZE: usize = 32 + 32 + 8 + 32 + 8 + 1 + 7; // 120 bytes with padding

/// Maximum metadata length
pub const MAX_METADATA_LEN: usize = 256;

/// Seeds for PDA derivation
pub const CATALOG_ROOT_SEED: &[u8] = b"catalog_root";
pub const CATALOG_PAGE_SEED: &[u8] = b"catalog_page";
pub const MANIFEST_SEED: &[u8] = b"manifest";
pub const CHUNK_SEED: &[u8] = b"chunk";

#[program]
pub mod cartridge_storage {
    use super::*;

    /// Initialize the catalog root. Only called once per program deployment.
    pub fn initialize_catalog(ctx: Context<InitializeCatalog>) -> Result<()> {
        let catalog_root = &mut ctx.accounts.catalog_root;
        catalog_root.version = 1;
        catalog_root.admin = ctx.accounts.admin.key();
        catalog_root.total_cartridges = 0;
        catalog_root.page_count = 0;
        catalog_root.latest_page_index = 0;
        catalog_root.bump = ctx.bumps.catalog_root;
        
        msg!("Catalog initialized with admin: {}", catalog_root.admin);
        Ok(())
    }

    /// Create a new catalog page. Called when current page is full.
    pub fn create_catalog_page(ctx: Context<CreateCatalogPage>, page_index: u32) -> Result<()> {
        let catalog_root = &mut ctx.accounts.catalog_root;
        let catalog_page = &mut ctx.accounts.catalog_page;
        
        require!(
            page_index == catalog_root.page_count,
            CartridgeError::InvalidPageIndex
        );
        
        catalog_page.page_index = page_index;
        catalog_page.entry_count = 0;
        catalog_page.bump = ctx.bumps.catalog_page;
        
        catalog_root.page_count += 1;
        catalog_root.latest_page_index = page_index;
        
        msg!("Created catalog page: {}", page_index);
        Ok(())
    }

    /// Create a cartridge manifest. This reserves the cartridge ID.
    pub fn create_manifest(
        ctx: Context<CreateManifest>,
        cartridge_id: [u8; 32],
        zip_size: u64,
        chunk_size: u32,
        sha256: [u8; 32],
        metadata: Vec<u8>,
    ) -> Result<()> {
        require!(zip_size > 0, CartridgeError::InvalidSize);
        require!(zip_size <= MAX_CARTRIDGE_SIZE, CartridgeError::CartridgeTooLarge);
        require!(chunk_size > 0 && chunk_size <= DEFAULT_CHUNK_SIZE, CartridgeError::InvalidChunkSize);
        require!(metadata.len() <= MAX_METADATA_LEN, CartridgeError::MetadataTooLarge);
        
        let num_chunks = ((zip_size as u32) + chunk_size - 1) / chunk_size;
        
        let manifest = &mut ctx.accounts.manifest;
        manifest.cartridge_id = cartridge_id;
        manifest.zip_size = zip_size;
        manifest.chunk_size = chunk_size;
        manifest.num_chunks = num_chunks;
        manifest.sha256 = sha256;
        manifest.finalized = false;
        manifest.created_slot = Clock::get()?.slot;
        manifest.publisher = ctx.accounts.publisher.key();
        manifest.metadata_len = metadata.len() as u16;
        manifest.bump = ctx.bumps.manifest;
        
        // Copy metadata
        manifest.metadata[..metadata.len()].copy_from_slice(&metadata);
        
        msg!("Created manifest for cartridge: {:?}, size: {}, chunks: {}", 
             cartridge_id, zip_size, num_chunks);
        Ok(())
    }

    /// Write data to a chunk account. The chunk account must be pre-allocated.
    pub fn write_chunk(
        ctx: Context<WriteChunk>,
        cartridge_id: [u8; 32],
        chunk_index: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        let manifest = &ctx.accounts.manifest;
        let chunk = &mut ctx.accounts.chunk;
        
        require!(!manifest.finalized, CartridgeError::CartridgeFinalized);
        require!(chunk_index < manifest.num_chunks, CartridgeError::InvalidChunkIndex);
        require!(!chunk.written, CartridgeError::ChunkAlreadyWritten);
        
        // Validate data size
        let expected_size = if chunk_index == manifest.num_chunks - 1 {
            // Last chunk may be smaller
            let remainder = manifest.zip_size as u32 % manifest.chunk_size;
            if remainder == 0 { manifest.chunk_size } else { remainder }
        } else {
            manifest.chunk_size
        };
        
        require!(
            data.len() as u32 == expected_size,
            CartridgeError::InvalidChunkSize
        );
        
        chunk.cartridge_id = cartridge_id;
        chunk.chunk_index = chunk_index;
        chunk.data_len = data.len() as u32;
        chunk.written = true;
        chunk.bump = ctx.bumps.chunk;
        
        // Write data to the data field
        chunk.data[..data.len()].copy_from_slice(&data);
        
        msg!("Wrote chunk {} for cartridge (size: {} bytes)", chunk_index, data.len());
        Ok(())
    }

    /// Finalize a cartridge after all chunks are written.
    /// This locks the cartridge and makes it discoverable via the catalog.
    pub fn finalize_cartridge(
        ctx: Context<FinalizeCartridge>,
        cartridge_id: [u8; 32],
        page_index: u32,
    ) -> Result<()> {
        let manifest = &mut ctx.accounts.manifest;
        let catalog_root = &mut ctx.accounts.catalog_root;
        let catalog_page = &mut ctx.accounts.catalog_page;
        
        require!(!manifest.finalized, CartridgeError::CartridgeFinalized);
        require!(page_index == catalog_root.latest_page_index, CartridgeError::InvalidPageIndex);
        require!(
            (catalog_page.entry_count as usize) < ENTRIES_PER_PAGE,
            CartridgeError::PageFull
        );
        
        // Mark as finalized
        manifest.finalized = true;
        
        // Add entry to catalog page
        let entry_idx = catalog_page.entry_count as usize;
        catalog_page.entries[entry_idx] = CatalogEntry {
            cartridge_id,
            manifest_pubkey: ctx.accounts.manifest.key(),
            zip_size: manifest.zip_size,
            sha256: manifest.sha256,
            created_slot: manifest.created_slot,
            flags: 0,
            _padding: [0u8; 7],
        };
        catalog_page.entry_count += 1;
        
        // Update catalog root
        catalog_root.total_cartridges += 1;
        
        msg!("Finalized cartridge: {:?}, total: {}", cartridge_id, catalog_root.total_cartridges);
        Ok(())
    }

    /// Update admin (admin only)
    pub fn update_admin(ctx: Context<UpdateAdmin>, new_admin: Pubkey) -> Result<()> {
        let catalog_root = &mut ctx.accounts.catalog_root;
        catalog_root.admin = new_admin;
        msg!("Admin updated to: {}", new_admin);
        Ok(())
    }
}

// ============================================================================
// Account Structures
// ============================================================================

/// Catalog root - global catalog metadata
#[account]
#[derive(Default)]
pub struct CatalogRoot {
    /// Schema version
    pub version: u8,
    /// Admin pubkey (can update catalog settings)
    pub admin: Pubkey,
    /// Total number of finalized cartridges
    pub total_cartridges: u64,
    /// Number of catalog pages
    pub page_count: u32,
    /// Index of the latest (current) page
    pub latest_page_index: u32,
    /// PDA bump
    pub bump: u8,
}

impl CatalogRoot {
    pub const LEN: usize = 8 + // discriminator
        1 +     // version
        32 +    // admin
        8 +     // total_cartridges
        4 +     // page_count
        4 +     // latest_page_index
        1 +     // bump
        16;     // padding for future fields
}

/// Single catalog entry
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct CatalogEntry {
    /// Content-addressed cartridge ID (sha256 of ZIP)
    pub cartridge_id: [u8; 32],
    /// Pubkey of the manifest account
    pub manifest_pubkey: Pubkey,
    /// Size of the ZIP file in bytes
    pub zip_size: u64,
    /// SHA256 hash of the ZIP file
    pub sha256: [u8; 32],
    /// Slot when the cartridge was created
    pub created_slot: u64,
    /// Flags (e.g., 0x01 = retired)
    pub flags: u8,
    /// Padding for alignment
    pub _padding: [u8; 7],
}

/// Catalog page - contains entries for discovery
#[account]
pub struct CatalogPage {
    /// Page index (0-based)
    pub page_index: u32,
    /// Number of entries in this page
    pub entry_count: u32,
    /// PDA bump
    pub bump: u8,
    /// Padding
    pub _padding: [u8; 7],
    /// Fixed-size array of entries
    pub entries: [CatalogEntry; ENTRIES_PER_PAGE],
}

impl CatalogPage {
    pub const LEN: usize = 8 + // discriminator
        4 +     // page_index
        4 +     // entry_count
        1 +     // bump
        7 +     // padding
        (CATALOG_ENTRY_SIZE * ENTRIES_PER_PAGE); // entries
}

/// Cartridge manifest - metadata for a cartridge
#[account]
pub struct CartridgeManifest {
    /// Content-addressed ID (sha256 of ZIP bytes)
    pub cartridge_id: [u8; 32],
    /// Total size of the ZIP file
    pub zip_size: u64,
    /// Size of each chunk
    pub chunk_size: u32,
    /// Number of chunks
    pub num_chunks: u32,
    /// SHA256 hash of the ZIP file
    pub sha256: [u8; 32],
    /// Whether the cartridge is finalized (locked)
    pub finalized: bool,
    /// Slot when the manifest was created
    pub created_slot: u64,
    /// Publisher pubkey
    pub publisher: Pubkey,
    /// Length of metadata
    pub metadata_len: u16,
    /// PDA bump
    pub bump: u8,
    /// Optional metadata (JSON, etc.)
    pub metadata: [u8; MAX_METADATA_LEN],
}

impl CartridgeManifest {
    pub const LEN: usize = 8 + // discriminator
        32 +    // cartridge_id
        8 +     // zip_size
        4 +     // chunk_size
        4 +     // num_chunks
        32 +    // sha256
        1 +     // finalized
        8 +     // created_slot
        32 +    // publisher
        2 +     // metadata_len
        1 +     // bump
        MAX_METADATA_LEN + // metadata
        16;     // padding
}

/// Cartridge chunk - raw bytes for a chunk
/// Note: This uses a fixed buffer. The account is sized based on chunk_size.
#[account]
pub struct CartridgeChunk {
    /// Cartridge ID this chunk belongs to
    pub cartridge_id: [u8; 32],
    /// Chunk index (0-based)
    pub chunk_index: u32,
    /// Length of data in this chunk
    pub data_len: u32,
    /// Whether this chunk has been written
    pub written: bool,
    /// PDA bump
    pub bump: u8,
    /// Raw chunk data (up to DEFAULT_CHUNK_SIZE bytes)
    #[max_len(131072)] // 128KB
    pub data: Vec<u8>,
}

impl CartridgeChunk {
    /// Calculate the space needed for a chunk account
    pub fn space(data_size: u32) -> usize {
        8 +     // discriminator
        32 +    // cartridge_id
        4 +     // chunk_index
        4 +     // data_len
        1 +     // written
        1 +     // bump
        4 +     // vec length prefix
        data_size as usize + // actual data
        32      // padding
    }
}

// ============================================================================
// Instruction Contexts
// ============================================================================

#[derive(Accounts)]
pub struct InitializeCatalog<'info> {
    #[account(
        init,
        payer = admin,
        space = CatalogRoot::LEN,
        seeds = [CATALOG_ROOT_SEED],
        bump
    )]
    pub catalog_root: Account<'info, CatalogRoot>,
    
    #[account(mut)]
    pub admin: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(page_index: u32)]
pub struct CreateCatalogPage<'info> {
    #[account(
        mut,
        seeds = [CATALOG_ROOT_SEED],
        bump = catalog_root.bump,
        constraint = admin.key() == catalog_root.admin @ CartridgeError::Unauthorized
    )]
    pub catalog_root: Account<'info, CatalogRoot>,
    
    #[account(
        init,
        payer = admin,
        space = CatalogPage::LEN,
        seeds = [CATALOG_PAGE_SEED, &page_index.to_le_bytes()],
        bump
    )]
    pub catalog_page: Account<'info, CatalogPage>,
    
    #[account(mut)]
    pub admin: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(cartridge_id: [u8; 32])]
pub struct CreateManifest<'info> {
    #[account(
        init,
        payer = publisher,
        space = CartridgeManifest::LEN,
        seeds = [MANIFEST_SEED, &cartridge_id],
        bump
    )]
    pub manifest: Account<'info, CartridgeManifest>,
    
    #[account(mut)]
    pub publisher: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(cartridge_id: [u8; 32], chunk_index: u32)]
pub struct WriteChunk<'info> {
    #[account(
        seeds = [MANIFEST_SEED, &cartridge_id],
        bump = manifest.bump,
        constraint = manifest.publisher == publisher.key() @ CartridgeError::Unauthorized
    )]
    pub manifest: Account<'info, CartridgeManifest>,
    
    #[account(
        init,
        payer = publisher,
        space = CartridgeChunk::space(manifest.chunk_size),
        seeds = [CHUNK_SEED, &cartridge_id, &chunk_index.to_le_bytes()],
        bump
    )]
    pub chunk: Account<'info, CartridgeChunk>,
    
    #[account(mut)]
    pub publisher: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(cartridge_id: [u8; 32], page_index: u32)]
pub struct FinalizeCartridge<'info> {
    #[account(
        mut,
        seeds = [MANIFEST_SEED, &cartridge_id],
        bump = manifest.bump,
        constraint = manifest.publisher == publisher.key() @ CartridgeError::Unauthorized
    )]
    pub manifest: Account<'info, CartridgeManifest>,
    
    #[account(
        mut,
        seeds = [CATALOG_ROOT_SEED],
        bump = catalog_root.bump
    )]
    pub catalog_root: Account<'info, CatalogRoot>,
    
    #[account(
        mut,
        seeds = [CATALOG_PAGE_SEED, &page_index.to_le_bytes()],
        bump = catalog_page.bump
    )]
    pub catalog_page: Account<'info, CatalogPage>,
    
    #[account(mut)]
    pub publisher: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateAdmin<'info> {
    #[account(
        mut,
        seeds = [CATALOG_ROOT_SEED],
        bump = catalog_root.bump,
        constraint = admin.key() == catalog_root.admin @ CartridgeError::Unauthorized
    )]
    pub catalog_root: Account<'info, CatalogRoot>,
    
    pub admin: Signer<'info>,
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum CartridgeError {
    #[msg("Unauthorized action")]
    Unauthorized,
    
    #[msg("Invalid cartridge size")]
    InvalidSize,
    
    #[msg("Cartridge size exceeds maximum (6MB)")]
    CartridgeTooLarge,
    
    #[msg("Invalid chunk size")]
    InvalidChunkSize,
    
    #[msg("Invalid chunk index")]
    InvalidChunkIndex,
    
    #[msg("Chunk has already been written")]
    ChunkAlreadyWritten,
    
    #[msg("Cartridge has already been finalized")]
    CartridgeFinalized,
    
    #[msg("Invalid page index")]
    InvalidPageIndex,
    
    #[msg("Catalog page is full")]
    PageFull,
    
    #[msg("Metadata too large")]
    MetadataTooLarge,
    
    #[msg("SHA256 hash mismatch")]
    HashMismatch,
}

