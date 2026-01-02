# Solana Retro - Application Improvements Document

This document outlines improvements for the Solana Retro application, focusing on upload performance, download efficiency (reducing RPC calls), and general enhancements.

## Table of Contents

1. [Upload Performance Improvements](#upload-performance-improvements)
2. [Download Performance & RPC Optimization](#download-performance--rpc-optimization)
3. [General Improvements](#general-improvements)
4. [Implementation Priority](#implementation-priority)

---

## Upload Performance Improvements

### 1. Parallel Chunk Uploads (High Priority)

**Current State:** Chunks are uploaded sequentially with a 400ms delay between each chunk.

**Problem:**
- For a 1MB cartridge (8 chunks), upload takes ~3.2 seconds + transaction confirmation time
- For a 6MB cartridge (48 chunks), upload takes ~19.2 seconds + transaction confirmation time
- Sequential uploads don't utilize network bandwidth efficiently

**Solution:**
- Implement parallel chunk uploads with configurable concurrency (e.g., 3-5 concurrent uploads)
- Use `Promise.all()` or `Promise.allSettled()` with a concurrency limiter
- Maintain rate limiting per RPC endpoint to avoid 429 errors

**Implementation:**
```typescript
// In SDK: client.ts - publishCartridge method
const CONCURRENT_CHUNKS = 3; // Configurable
const chunkPromises: Promise<string>[] = [];

for (let i = 0; i < chunks.length; i += CONCURRENT_CHUNKS) {
  const batch = chunks.slice(i, i + CONCURRENT_CHUNKS);
  const batchPromises = batch.map((chunk, idx) => 
    retry(() => this.writeChunk(publisher, cartridgeId, i + idx, chunk), 5, 1000)
  );
  
  const batchResults = await Promise.allSettled(batchPromises);
  // Handle results and update progress
  
  // Small delay between batches to avoid overwhelming RPC
  if (i + CONCURRENT_CHUNKS < chunks.length) {
    await sleep(200);
  }
}
```

**Expected Impact:**
- 3-5x faster uploads for large cartridges
- Better network utilization
- Reduced total upload time

---

### 2. Transaction Batching (Medium Priority)

**Current State:** Each chunk requires a separate transaction.

**Problem:**
- High transaction overhead (signature verification, network round-trips)
- Multiple transaction fees

**Solution:**
- Batch multiple chunk writes into a single transaction where possible
- Solana transactions can include multiple instructions (up to ~1232 bytes total)
- For 128KB chunks, we can't fit multiple chunks in one transaction, but we can:
  - Batch manifest creation with first chunk
  - Batch finalization with catalog update
  - Use Versioned Transactions for better efficiency

**Implementation:**
```typescript
// Batch manifest + first chunk
const manifestIx = createManifestInstruction(...);
const firstChunkIx = createChunkInstruction(cartridgeId, 0, chunks[0]);
const tx1 = new Transaction().add(manifestIx, firstChunkIx);
await sendAndConfirmTransaction(connection, tx1, [publisher]);

// Batch finalization with catalog update (if possible)
// Note: This may require program changes
```

**Expected Impact:**
- 20-30% reduction in transaction count
- Faster overall upload time
- Lower transaction fees

---

### 3. Connection Pooling & Keep-Alive (Medium Priority)

**Current State:** New Connection instances may be created for each operation.

**Problem:**
- Connection overhead for each request
- No connection reuse

**Solution:**
- Reuse Connection instances
- Implement connection pooling for multiple RPC endpoints
- Use HTTP keep-alive connections

**Implementation:**
```typescript
// Connection manager
class ConnectionPool {
  private connections: Map<string, Connection> = new Map();
  
  getConnection(endpoint: string): Connection {
    if (!this.connections.has(endpoint)) {
      this.connections.set(endpoint, new Connection(endpoint, {
        commitment: 'confirmed',
        httpHeaders: {
          'Connection': 'keep-alive'
        }
      }));
    }
    return this.connections.get(endpoint)!;
  }
}
```

**Expected Impact:**
- Reduced connection overhead
- Faster request processing
- Better resource utilization

---

### 4. Compression Before Upload (Low Priority)

**Current State:** ZIP files are uploaded as-is.

**Problem:**
- Some ZIP files may not be optimally compressed
- Larger uploads = more chunks = more transactions

**Solution:**
- Re-compress ZIP files with maximum compression before upload
- Use libraries like `pako` or native compression
- Only re-compress if it results in significant size reduction

**Implementation:**
```typescript
// Before upload
import pako from 'pako';

async function optimizeZip(zipBytes: Uint8Array): Promise<Uint8Array> {
  // Decompress, re-compress with max compression
  // Only if size reduction > 5%
}
```

**Expected Impact:**
- 10-30% size reduction for some files
- Fewer chunks to upload
- Lower storage costs

---

### 5. Chunk Size Optimization (Low Priority)

**Current State:** Default chunk size is 128KB.

**Problem:**
- Fixed chunk size may not be optimal for all file sizes
- Smaller files waste account space
- Larger chunks = fewer transactions but higher risk of transaction size limits

**Solution:**
- Dynamic chunk sizing based on file size
- Use larger chunks (256KB) for very large files if RPC supports it
- Use smaller chunks (64KB) for smaller files to reduce rent costs

**Implementation:**
```typescript
function calculateOptimalChunkSize(fileSize: number): number {
  if (fileSize < 512 * 1024) return 64 * 1024;  // 64KB for small files
  if (fileSize < 2 * 1024 * 1024) return 128 * 1024;  // 128KB default
  return 256 * 1024;  // 256KB for large files (if RPC supports)
}
```

**Expected Impact:**
- Optimized transaction count
- Better cost efficiency
- Faster uploads for large files

---

## Download Performance & RPC Optimization

### 1. Optimize Batch Fetching (High Priority)

**Current State:** Chunks are fetched in batches of 100 using `getMultipleAccountsInfo`.

**Problem:**
- Each batch is a separate RPC call
- For 48 chunks, that's 1 call (good), but for 100+ chunks, multiple calls
- No parallel batch fetching

**Solution:**
- Fetch all batches in parallel
- Increase batch size if RPC supports it (some support up to 1000)
- Use `getMultipleAccountsInfo` more efficiently

**Implementation:**
```typescript
// In SDK: client.ts - fetchCartridgeBytes method
const BATCH_SIZE = 100; // Or 1000 if RPC supports
const chunkBatches = batch(chunkPDAs, BATCH_SIZE);

// Fetch all batches in parallel
const batchPromises = chunkBatches.map(batchPDAs => {
  const pubkeys = batchPDAs.map(([pk]) => pk);
  return retry(() => 
    this.connection.getMultipleAccountsInfo(pubkeys)
  );
});

const batchResults = await Promise.all(batchPromises);

// Process results
for (let i = 0; i < batchResults.length; i++) {
  const accountInfos = batchResults[i];
  // Process chunk data...
}
```

**Expected Impact:**
- 5-10x faster downloads for large cartridges
- Reduced total RPC calls
- Better parallelization

---

### 2. Smart Caching Strategy (High Priority)

**Current State:** Basic caching exists but could be improved.

**Problem:**
- Cache may not persist across sessions
- No cache invalidation strategy
- No partial cache support

**Solution:**
- Implement IndexedDB caching for browser (persistent)
- Cache individual chunks, not just full files
- Implement cache versioning and invalidation
- Support partial downloads (resume from cache)

**Implementation:**
```typescript
// Enhanced cache with chunk-level caching
class ChunkCache {
  async getChunk(cartridgeId: string, chunkIndex: number): Promise<Uint8Array | null> {
    // Check IndexedDB for specific chunk
  }
  
  async setChunk(cartridgeId: string, chunkIndex: number, data: Uint8Array): Promise<void> {
    // Store chunk in IndexedDB
  }
  
  async getCachedChunks(cartridgeId: string, totalChunks: number): Promise<Map<number, Uint8Array>> {
    // Get all cached chunks for a cartridge
  }
}

// In download: check cache first, only fetch missing chunks
const cachedChunks = await chunkCache.getCachedChunks(cartridgeId, totalChunks);
const missingChunkIndices = Array.from({ length: totalChunks }, (_, i) => i)
  .filter(i => !cachedChunks.has(i));

// Only fetch missing chunks
```

**Expected Impact:**
- Instant loads for previously downloaded cartridges
- Reduced RPC calls on subsequent loads
- Better user experience

---

### 3. Prefetching Strategy (Medium Priority)

**Current State:** No prefetching of cartridges.

**Problem:**
- Users wait for full download before playing
- No background loading

**Solution:**
- Prefetch cartridges in catalog view (low priority, background)
- Progressive loading: start playing when first chunk is available (for some formats)
- Prefetch related cartridges

**Implementation:**
```typescript
// Prefetch cartridges when catalog is loaded
async function prefetchCartridges(cartridgeIds: string[]) {
  // Use requestIdleCallback or Web Workers for background prefetching
  for (const id of cartridgeIds.slice(0, 3)) { // Prefetch top 3
    requestIdleCallback(() => {
      client.fetchCartridgeBytes(id, { verifyHash: false });
    });
  }
}
```

**Expected Impact:**
- Faster perceived load times
- Better user experience
- Reduced wait time

---

### 4. RPC Endpoint Load Balancing (Medium Priority)

**Current State:** Round-robin across endpoints exists but could be improved.

**Problem:**
- Simple round-robin doesn't account for endpoint health
- No automatic failover
- No endpoint performance tracking

**Solution:**
- Implement health checks for RPC endpoints
- Track endpoint performance (latency, error rate)
- Automatic failover to healthy endpoints
- Weighted round-robin based on performance

**Implementation:**
```typescript
class RpcEndpointManager {
  private endpoints: Array<{ url: string; health: 'healthy' | 'degraded' | 'down'; latency: number }> = [];
  
  async getBestEndpoint(): Promise<string> {
    // Return fastest healthy endpoint
    const healthy = this.endpoints.filter(e => e.health === 'healthy');
    return healthy.sort((a, b) => a.latency - b.latency)[0].url;
  }
  
  async healthCheck(endpoint: string): Promise<void> {
    // Ping endpoint, measure latency
  }
}
```

**Expected Impact:**
- More reliable downloads
- Better performance
- Automatic recovery from endpoint issues

---

### 5. Reduce Redundant RPC Calls (Medium Priority)

**Current State:** Some operations may make redundant calls.

**Problem:**
- Manifest fetched multiple times
- Catalog pages fetched individually
- No request deduplication

**Solution:**
- Implement request deduplication (same request in flight = reuse promise)
- Cache manifest and catalog data in memory
- Batch related requests

**Implementation:**
```typescript
class RequestDeduplicator {
  private pendingRequests: Map<string, Promise<any>> = new Map();
  
  async deduplicate<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.pendingRequests.has(key)) {
      return this.pendingRequests.get(key)!;
    }
    
    const promise = fn().finally(() => {
      this.pendingRequests.delete(key);
    });
    
    this.pendingRequests.set(key, promise);
    return promise;
  }
}

// Usage
const manifest = await deduplicator.deduplicate(
  `manifest-${cartridgeId}`,
  () => this.getManifest(cartridgeId)
);
```

**Expected Impact:**
- Reduced RPC calls
- Faster operations
- Lower rate limit usage

---

### 6. Use getProgramAccounts for Bulk Operations (Low Priority)

**Current State:** Individual account fetches for catalog pages.

**Problem:**
- Multiple RPC calls to fetch catalog
- Could use `getProgramAccounts` for bulk fetching

**Solution:**
- Use `getProgramAccounts` with filters to fetch all catalog pages at once
- Use `getProgramAccounts` to fetch all chunks for a cartridge (if filters support it)

**Note:** This may not be feasible depending on RPC provider limits and filter support.

**Implementation:**
```typescript
// Fetch all catalog pages using getProgramAccounts
const catalogPages = await connection.getProgramAccounts(programId, {
  filters: [
    { memcmp: { offset: 0, bytes: catalogPageDiscriminator } }
  ]
});
```

**Expected Impact:**
- Single RPC call for catalog
- Faster catalog loading
- Reduced RPC usage

---

## General Improvements

### 1. Error Handling & Recovery (High Priority)

**Current State:** Basic error handling exists.

**Improvements:**
- More granular error types
- Automatic retry with exponential backoff (already exists, but improve)
- Better error messages for users
- Error recovery strategies (e.g., retry failed chunks)

**Implementation:**
```typescript
class CartridgeError extends Error {
  constructor(
    message: string,
    public code: string,
    public retryable: boolean,
    public context?: any
  ) {
    super(message);
  }
}

// Specific error types
class ChunkNotFoundError extends CartridgeError {
  constructor(chunkIndex: number) {
    super(`Chunk ${chunkIndex} not found`, 'CHUNK_NOT_FOUND', true, { chunkIndex });
  }
}

// Retry logic with recovery
async function fetchWithRecovery<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  // Implement recovery strategies
}
```

---

### 2. Progress Tracking Improvements (Medium Priority)

**Current State:** Basic progress tracking exists.

**Improvements:**
- More detailed progress information (bytes/sec, ETA)
- Progress persistence (resume interrupted uploads/downloads)
- Better UI feedback

**Implementation:**
```typescript
interface DetailedProgress {
  phase: string;
  chunksLoaded: number;
  totalChunks: number;
  bytesLoaded: number;
  totalBytes: number;
  bytesPerSecond: number;
  estimatedTimeRemaining: number;
  currentOperation: string;
}
```

---

### 3. Rate Limiting Improvements (Medium Priority)

**Current State:** Basic rate limiting exists.

**Improvements:**
- Per-endpoint rate limiting
- Adaptive rate limiting based on endpoint responses
- Better 429 error handling
- Rate limit sharing across application instances (if needed)

**Implementation:**
```typescript
class AdaptiveRateLimiter {
  private endpointLimits: Map<string, RateLimiter> = new Map();
  
  async rateLimit(endpoint: string): Promise<void> {
    if (!this.endpointLimits.has(endpoint)) {
      this.endpointLimits.set(endpoint, createRateLimiter(40, 10000));
    }
    await this.endpointLimits.get(endpoint)!.rateLimit();
  }
  
  adjustLimit(endpoint: string, success: boolean): void {
    // Adjust limits based on success/failure
  }
}
```

---

### 4. Code Organization & Maintainability (Medium Priority)

**Improvements:**
- Better separation of concerns
- Shared types between SDK and web
- Consistent error handling patterns
- Better documentation

**Structure:**
```
sdk/
  src/
    client.ts          # Main client
    connection.ts      # Connection management
    cache.ts           # Caching logic
    rateLimiter.ts     # Rate limiting
    errors.ts          # Error types
    types.ts           # Shared types
```

---

### 5. Testing & Quality Assurance (Medium Priority)

**Improvements:**
- Unit tests for critical paths
- Integration tests for upload/download flows
- Performance benchmarks
- Load testing

**Implementation:**
```typescript
// Example test
describe('CartridgeClient', () => {
  it('should upload cartridge in parallel', async () => {
    // Test parallel uploads
  });
  
  it('should cache chunks correctly', async () => {
    // Test caching
  });
});
```

---

### 6. Monitoring & Observability (Low Priority)

**Improvements:**
- Logging for debugging
- Performance metrics
- Error tracking
- User analytics (optional, privacy-respecting)

**Implementation:**
```typescript
class Metrics {
  trackUpload(cartridgeId: string, duration: number, chunks: number): void {
    // Track upload metrics
  }
  
  trackDownload(cartridgeId: string, duration: number, chunks: number): void {
    // Track download metrics
  }
}
```

---

### 7. Documentation Improvements (Low Priority)

**Improvements:**
- API documentation
- Performance tuning guide
- Troubleshooting guide
- Best practices

---

## Implementation Priority

### Phase 1: High Impact, Low Effort (Quick Wins)
1. ✅ Parallel chunk uploads
2. ✅ Optimize batch fetching (parallel batches)
3. ✅ Smart caching strategy (chunk-level)
4. ✅ Reduce redundant RPC calls

**Estimated Impact:** 5-10x faster uploads, 3-5x faster downloads

### Phase 2: High Impact, Medium Effort
1. Transaction batching
2. Connection pooling
3. RPC endpoint load balancing
4. Error handling improvements

**Estimated Impact:** 20-30% additional performance gains

### Phase 3: Medium Impact, Various Effort
1. Prefetching strategy
2. Progress tracking improvements
3. Rate limiting improvements
4. Code organization

**Estimated Impact:** Better UX, maintainability

### Phase 4: Nice to Have
1. Compression optimization
2. Chunk size optimization
3. getProgramAccounts usage
4. Monitoring & observability

**Estimated Impact:** Incremental improvements

---

## Metrics to Track

To measure the effectiveness of these improvements, track:

1. **Upload Metrics:**
   - Total upload time
   - Chunks per second
   - Transaction success rate
   - Average transaction confirmation time

2. **Download Metrics:**
   - Total download time
   - RPC calls per download
   - Cache hit rate
   - Bytes per second

3. **Error Metrics:**
   - 429 error rate
   - Retry count
   - Failure rate

4. **User Experience:**
   - Time to first playable
   - Perceived load time

---

## Notes

- Some improvements may require program changes (e.g., transaction batching)
- Test thoroughly with different RPC providers (public vs. private)
- Consider rate limits of different RPC providers
- Monitor costs (rent, transaction fees) when optimizing
- Balance performance with reliability

---

## Conclusion

Focusing on parallel operations, smart caching, and RPC optimization will provide the biggest performance gains. Start with Phase 1 improvements for immediate impact, then iterate based on metrics and user feedback.

