import { ref, computed } from 'vue'
import { Connection, PublicKey } from '@solana/web3.js'
import { useCache } from './useCache.js'

/**
 * Solana Cartridge loader composable
 * Fetches cartridge manifest and chunks from Solana accounts
 */

// Program constants
const PROGRAM_ID = new PublicKey('CartS1QpBgPfpgq4RpPpXVuvN4SrJvYNXBfW9D1Rmvp')
const MANIFEST_SEED = Buffer.from('manifest')
const CHUNK_SEED = Buffer.from('chunk')

// PDA derivation
function deriveManifestPDA(cartridgeId) {
  const idBytes = typeof cartridgeId === 'string' ? hexToBytes(cartridgeId) : cartridgeId
  return PublicKey.findProgramAddressSync([MANIFEST_SEED, Buffer.from(idBytes)], PROGRAM_ID)
}

function deriveChunkPDA(cartridgeId, chunkIndex) {
  const idBytes = typeof cartridgeId === 'string' ? hexToBytes(cartridgeId) : cartridgeId
  const chunkIndexBuffer = Buffer.alloc(4)
  chunkIndexBuffer.writeUInt32LE(chunkIndex)
  return PublicKey.findProgramAddressSync([CHUNK_SEED, Buffer.from(idBytes), chunkIndexBuffer], PROGRAM_ID)
}

// Decode functions
function decodeCartridgeManifest(data) {
  const buffer = Buffer.from(data)
  let offset = 8 // Skip discriminator
  
  const cartridgeId = new Uint8Array(buffer.subarray(offset, offset + 32))
  offset += 32
  
  const zipSize = buffer.readBigUInt64LE(offset)
  offset += 8
  
  const chunkSize = buffer.readUInt32LE(offset)
  offset += 4
  
  const numChunks = buffer.readUInt32LE(offset)
  offset += 4
  
  const sha256 = new Uint8Array(buffer.subarray(offset, offset + 32))
  offset += 32
  
  const finalized = buffer.readUInt8(offset) !== 0
  offset += 1
  
  const createdSlot = buffer.readBigUInt64LE(offset)
  offset += 8
  
  const publisher = new PublicKey(buffer.subarray(offset, offset + 32))
  offset += 32
  
  const metadataLen = buffer.readUInt16LE(offset)
  offset += 2
  
  const bump = buffer.readUInt8(offset)
  offset += 1
  
  const metadata = buffer.subarray(offset, offset + metadataLen)
  
  return {
    cartridgeId,
    zipSize: Number(zipSize),
    chunkSize,
    numChunks,
    sha256,
    finalized,
    createdSlot: Number(createdSlot),
    publisher,
    metadataLen,
    bump,
    metadata
  }
}

function decodeCartridgeChunk(data) {
  const buffer = Buffer.from(data)
  let offset = 8 // Skip discriminator
  
  offset += 32 // cartridgeId
  offset += 4 // chunkIndex
  
  const dataLen = buffer.readUInt32LE(offset)
  offset += 4
  
  offset += 1 // written
  offset += 1 // bump
  
  const vecLen = buffer.readUInt32LE(offset)
  offset += 4
  
  const chunkData = new Uint8Array(buffer.subarray(offset, offset + Math.min(vecLen, dataLen)))
  
  return chunkData
}

// Utility functions
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex) {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(cleanHex.length / 2)
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16)
  }
  return bytes
}

async function verifySHA256(data, expectedHash) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  
  const expectedHex = expectedHash instanceof Uint8Array 
    ? bytesToHex(expectedHash) 
    : expectedHash
  
  return hashHex.toLowerCase() === expectedHex.toLowerCase()
}

export function useSolanaCartridge(rpcEndpoint, cartridgeId) {
  const loading = ref(false)
  const error = ref(null)
  const fileData = ref(null)
  const verified = ref(false)
  const cartHeader = ref(null)
  const progress = ref({
    chunksFound: 0,
    expectedChunks: 0,
    bytes: 0,
    rate: 0,
    phase: 'idle',
    statusMessage: ''
  })

  const cache = useCache()

  const progressPercent = computed(() => {
    if (progress.value.expectedChunks === 0) return 0
    const percent = (progress.value.chunksFound / progress.value.expectedChunks) * 100
    return Math.min(100, Math.max(0, percent))
  })

  /**
   * Load cartridge info (manifest) without downloading chunks
   */
  async function loadCartridgeInfo() {
    if (!cartridgeId.value || !rpcEndpoint.value) {
      error.value = 'Cartridge ID or RPC endpoint not configured'
      return
    }

    console.log('Loading cartridge info for:', cartridgeId.value)

    try {
      const connection = new Connection(rpcEndpoint.value, 'confirmed')
      const [manifestPDA] = deriveManifestPDA(cartridgeId.value)
      
      const manifestInfo = await connection.getAccountInfo(manifestPDA)
      
      if (!manifestInfo) {
        error.value = 'Cartridge manifest not found'
        return
      }

      const manifest = decodeCartridgeManifest(manifestInfo.data)
      
      // Parse metadata if present
      let metadata = {}
      if (manifest.metadataLen > 0) {
        try {
          const metadataStr = new TextDecoder().decode(manifest.metadata)
          metadata = JSON.parse(metadataStr)
        } catch (e) {
          console.warn('Failed to parse manifest metadata:', e)
        }
      }

      cartHeader.value = {
        cartridgeId: bytesToHex(manifest.cartridgeId),
        totalSize: manifest.zipSize,
        chunkSize: manifest.chunkSize,
        numChunks: manifest.numChunks,
        sha256: bytesToHex(manifest.sha256),
        finalized: manifest.finalized,
        createdSlot: manifest.createdSlot,
        publisher: manifest.publisher.toBase58(),
        platform: metadata.platform || 0,
        metadata
      }

      // Check cache
      const cacheKey = {
        cartridgeId: cartHeader.value.cartridgeId,
        sha256: cartHeader.value.sha256
      }
      
      const cachedData = await cache.loadFromCache(cacheKey)
      if (cachedData) {
        const isValid = await verifySHA256(cachedData, manifest.sha256)
        if (isValid) {
          console.log('Loaded from cache')
          fileData.value = cachedData
          verified.value = true
          progress.value = {
            chunksFound: manifest.numChunks,
            expectedChunks: manifest.numChunks,
            bytes: manifest.zipSize,
            rate: 0,
            phase: 'idle'
          }
        } else {
          await cache.clearCache(cacheKey)
        }
      }

    } catch (err) {
      error.value = err.message || 'Failed to load cartridge info'
      console.error('Cartridge info loading error:', err)
    }
  }

  /**
   * Load full cartridge (download all chunks)
   */
  async function loadCartridge() {
    if (!cartridgeId.value || !rpcEndpoint.value) {
      error.value = 'Cartridge ID or RPC endpoint not configured'
      return
    }

    // If already loaded from cache, return
    if (fileData.value && verified.value && cartHeader.value) {
      console.log('Cartridge already loaded from cache')
      return
    }

    loading.value = true
    error.value = null
    const startTime = Date.now()

    try {
      const connection = new Connection(rpcEndpoint.value, 'confirmed')
      
      // First get manifest if not already loaded
      if (!cartHeader.value) {
        await loadCartridgeInfo()
        if (!cartHeader.value) {
          loading.value = false
          return
        }
      }

      const manifest = cartHeader.value
      const numChunks = manifest.numChunks
      const totalBytes = manifest.totalSize

      progress.value = {
        chunksFound: 0,
        expectedChunks: numChunks,
        bytes: 0,
        rate: 0,
        phase: 'fetching-chunks',
        statusMessage: 'Downloading chunks from Solana...'
      }

      // Derive all chunk PDAs
      const chunkPDAs = []
      for (let i = 0; i < numChunks; i++) {
        const [pda] = deriveChunkPDA(cartridgeId.value, i)
        chunkPDAs.push(pda)
      }

      // Fetch chunks in batches (getMultipleAccountsInfo has limit of 100)
      const BATCH_SIZE = 100
      const chunks = new Array(numChunks).fill(null)
      let chunksLoaded = 0
      let bytesLoaded = 0

      for (let batchStart = 0; batchStart < chunkPDAs.length; batchStart += BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + BATCH_SIZE, chunkPDAs.length)
        const batchPDAs = chunkPDAs.slice(batchStart, batchEnd)
        
        const accountInfos = await connection.getMultipleAccountsInfo(batchPDAs)
        
        for (let i = 0; i < accountInfos.length; i++) {
          const info = accountInfos[i]
          if (info && info.data) {
            const chunkData = decodeCartridgeChunk(info.data)
            const globalIndex = batchStart + i
            chunks[globalIndex] = chunkData
            chunksLoaded++
            bytesLoaded += chunkData.length
          }
        }

        progress.value.chunksFound = chunksLoaded
        progress.value.bytes = bytesLoaded
        const elapsed = (Date.now() - startTime) / 1000
        if (elapsed > 0) {
          progress.value.rate = chunksLoaded / elapsed
        }

        // Yield to UI
        await new Promise(resolve => setTimeout(resolve, 0))
      }

      // Check for missing chunks
      const missingChunks = chunks.reduce((acc, c, i) => c === null ? [...acc, i] : acc, [])
      if (missingChunks.length > 0) {
        error.value = `Missing ${missingChunks.length} chunks: ${missingChunks.slice(0, 10).join(', ')}${missingChunks.length > 10 ? '...' : ''}`
        loading.value = false
        return
      }

      // Reconstruct ZIP
      progress.value.phase = 'reconstructing'
      progress.value.statusMessage = 'Reconstructing file...'

      const reconstructed = new Uint8Array(totalBytes)
      let offset = 0
      for (const chunk of chunks) {
        reconstructed.set(chunk, offset)
        offset += chunk.length
      }

      // Verify SHA256
      progress.value.phase = 'verifying'
      progress.value.statusMessage = 'Verifying integrity...'

      const isValid = await verifySHA256(reconstructed, manifest.sha256)
      verified.value = isValid

      if (!isValid) {
        error.value = 'SHA256 verification failed!'
        loading.value = false
        return
      }

      fileData.value = reconstructed

      // Save to cache
      const cacheKey = {
        cartridgeId: manifest.cartridgeId,
        sha256: manifest.sha256
      }
      await cache.saveToCache(cacheKey, reconstructed)

      progress.value.phase = 'idle'
      progress.value.statusMessage = ''

    } catch (err) {
      error.value = err.message || 'Failed to load cartridge'
      console.error('Cartridge loading error:', err)
    } finally {
      loading.value = false
    }
  }

  /**
   * Extract run.json from ZIP file
   */
  async function extractRunJson() {
    if (!fileData.value || !verified.value) {
      return null
    }

    try {
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(fileData.value)
      
      const runJsonFile = zip.files['run.json']
      if (!runJsonFile || runJsonFile.dir) {
        return null
      }

      const runJsonText = await runJsonFile.async('string')
      return JSON.parse(runJsonText)
    } catch (err) {
      console.warn('Failed to extract run.json:', err)
      return null
    }
  }

  /**
   * Clear cache for current cartridge
   */
  async function clearCache() {
    if (!cartHeader.value) return
    
    const cacheKey = {
      cartridgeId: cartHeader.value.cartridgeId,
      sha256: cartHeader.value.sha256
    }
    
    await cache.clearCache(cacheKey)
    
    fileData.value = null
    verified.value = false
    progress.value = {
      chunksFound: 0,
      expectedChunks: 0,
      bytes: 0,
      rate: 0,
      phase: 'idle',
      statusMessage: ''
    }
    
    console.log('Cache cleared, cartridge state reset')
  }

  return {
    loading,
    error,
    fileData,
    verified,
    cartHeader,
    progress,
    progressPercent,
    loadCartridgeInfo,
    loadCartridge,
    extractRunJson,
    clearCache
  }
}

