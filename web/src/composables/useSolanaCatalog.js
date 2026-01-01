import { ref, computed } from 'vue'
import { Connection, PublicKey } from '@solana/web3.js'

/**
 * Solana Catalog loader composable
 * Fetches catalog entries from on-chain Solana accounts
 */

// Program constants
const PROGRAM_ID = new PublicKey('CartS1QpBgPfpgq4RpPpXVuvN4SrJvYNXBfW9D1Rmvp')
const CATALOG_ROOT_SEED = Buffer.from('catalog_root')
const CATALOG_PAGE_SEED = Buffer.from('catalog_page')

// PDA derivation
function deriveCatalogRootPDA() {
  return PublicKey.findProgramAddressSync([CATALOG_ROOT_SEED], PROGRAM_ID)
}

function deriveCatalogPagePDA(pageIndex) {
  const pageIndexBuffer = Buffer.alloc(4)
  pageIndexBuffer.writeUInt32LE(pageIndex)
  return PublicKey.findProgramAddressSync([CATALOG_PAGE_SEED, pageIndexBuffer], PROGRAM_ID)
}

// Decode functions
function decodeCatalogRoot(data) {
  const buffer = Buffer.from(data)
  let offset = 8 // Skip discriminator
  
  const version = buffer.readUInt8(offset)
  offset += 1
  
  const admin = new PublicKey(buffer.subarray(offset, offset + 32))
  offset += 32
  
  const totalCartridges = buffer.readBigUInt64LE(offset)
  offset += 8
  
  const pageCount = buffer.readUInt32LE(offset)
  offset += 4
  
  const latestPageIndex = buffer.readUInt32LE(offset)
  offset += 4
  
  const bump = buffer.readUInt8(offset)
  
  return { version, admin, totalCartridges, pageCount, latestPageIndex, bump }
}

function decodeCatalogEntry(buffer, offset) {
  const cartridgeId = new Uint8Array(buffer.subarray(offset, offset + 32))
  offset += 32
  
  const manifestPubkey = new PublicKey(buffer.subarray(offset, offset + 32))
  offset += 32
  
  const zipSize = buffer.readBigUInt64LE(offset)
  offset += 8
  
  const sha256 = new Uint8Array(buffer.subarray(offset, offset + 32))
  offset += 32
  
  const createdSlot = buffer.readBigUInt64LE(offset)
  offset += 8
  
  const flags = buffer.readUInt8(offset)
  
  return { cartridgeId, manifestPubkey, zipSize, sha256, createdSlot, flags }
}

const CATALOG_ENTRY_SIZE = 32 + 32 + 8 + 32 + 8 + 1 + 7 // 120 bytes with padding
const ENTRIES_PER_PAGE = 32

function decodeCatalogPage(data) {
  const buffer = Buffer.from(data)
  let offset = 8 // Skip discriminator
  
  const pageIndex = buffer.readUInt32LE(offset)
  offset += 4
  
  const entryCount = buffer.readUInt32LE(offset)
  offset += 4
  
  const bump = buffer.readUInt8(offset)
  offset += 1
  
  // Skip padding
  offset += 7
  
  const entries = []
  for (let i = 0; i < Math.min(entryCount, ENTRIES_PER_PAGE); i++) {
    entries.push(decodeCatalogEntry(buffer, offset + i * CATALOG_ENTRY_SIZE))
  }
  
  return { pageIndex, entryCount, bump, entries }
}

// Utility functions
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function useSolanaCatalog(rpcEndpoint, showRetiredGames = null) {
  const loading = ref(false)
  const error = ref(null)
  const games = ref([])
  const rawEntries = ref([])

  /**
   * Load catalog from Solana blockchain
   */
  async function loadCatalog() {
    if (!rpcEndpoint.value) {
      error.value = 'RPC endpoint not configured'
      return
    }

    loading.value = true
    error.value = null
    rawEntries.value = []
    games.value = []

    try {
      const connection = new Connection(rpcEndpoint.value, 'confirmed')

      // Fetch catalog root
      const [catalogRootPDA] = deriveCatalogRootPDA()
      const rootInfo = await connection.getAccountInfo(catalogRootPDA)

      if (!rootInfo) {
        error.value = 'Catalog not initialized on this network'
        loading.value = false
        return
      }

      const catalogRoot = decodeCatalogRoot(rootInfo.data)
      console.log(`Catalog found: ${catalogRoot.totalCartridges} cartridges in ${catalogRoot.pageCount} pages`)

      // Fetch all pages
      const entries = []
      for (let pageIdx = 0; pageIdx < catalogRoot.pageCount; pageIdx++) {
        const [pagePDA] = deriveCatalogPagePDA(pageIdx)
        const pageInfo = await connection.getAccountInfo(pagePDA)
        
        if (pageInfo) {
          const page = decodeCatalogPage(pageInfo.data)
          entries.push(...page.entries)
        }
      }

      rawEntries.value = entries
      console.log(`Fetched ${entries.length} catalog entries`)

      // Flag constant for retired apps
      const FLAG_RETIRED = 0x01
      const shouldShowRetired = showRetiredGames?.value ?? false

      // Convert entries to game format
      // For Solana, we use cartridge_id as the unique identifier
      // Games are individual cartridges (no versioning like Nimiq)
      const gamesMap = new Map()

      for (const entry of entries) {
        const isRetired = (entry.flags & FLAG_RETIRED) !== 0
        if (isRetired && !shouldShowRetired) continue

        const cartridgeIdHex = bytesToHex(entry.cartridgeId)
        
        // Each cartridge is a separate "game" in the Solana model
        // We use the first 8 bytes of cartridge_id as a pseudo app_id
        const appId = cartridgeIdHex.substring(0, 16)

        if (!gamesMap.has(appId)) {
          gamesMap.set(appId, {
            appId,
            title: `Game ${appId.substring(0, 8)}...`, // Will be updated when manifest metadata is loaded
            platform: 'Unknown', // Will be loaded from manifest metadata
            retired: isRetired,
            versions: []
          })
        }

        const game = gamesMap.get(appId)
        game.versions.push({
          semver: { major: 1, minor: 0, patch: 0, string: '1.0.0' },
          cartridgeAddress: cartridgeIdHex, // Use cartridge ID instead of Nimiq address
          cartridgeId: entry.cartridgeId,
          manifestPubkey: entry.manifestPubkey,
          zipSize: Number(entry.zipSize),
          sha256: bytesToHex(entry.sha256),
          createdSlot: Number(entry.createdSlot),
          flags: entry.flags
        })
      }

      games.value = Array.from(gamesMap.values())
      console.log(`Grouped into ${games.value.length} games`)

    } catch (err) {
      error.value = err.message || 'Failed to load catalog'
      console.error('Catalog loading error:', err)
    } finally {
      loading.value = false
    }
  }

  /**
   * Get latest version of a game
   */
  function getLatestVersion(appId) {
    const game = games.value.find(g => g.appId === appId)
    return game && game.versions.length > 0 ? game.versions[0] : null
  }

  return {
    loading,
    error,
    games,
    rawEntries,
    loadCatalog,
    getLatestVersion
  }
}

