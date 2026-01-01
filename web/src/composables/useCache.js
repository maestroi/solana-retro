const CACHE_DB_NAME = 'nimiq-doom-cache'
const CACHE_DB_VERSION = 1
const CACHE_STORE_NAME = 'game-files'

let cacheDB = null

export function useCache() {
  async function initCache() {
    if (cacheDB) return cacheDB
    
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION)
      
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        cacheDB = request.result
        resolve(cacheDB)
      }
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result
        if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
          db.createObjectStore(CACHE_STORE_NAME, { keyPath: 'key' })
        }
      }
    })
  }

  function getCacheKey(gameInfo) {
    if (!gameInfo) return null
    // Use cartridge_id or game_id, and sha256 for cache key
    const id = gameInfo.cartridgeId || gameInfo.game_id || 'unknown'
    const hash = gameInfo.sha256 || 'unknown'
    return `${id}_${hash}`
  }

  async function loadFromCache(gameInfo) {
    try {
      const db = await initCache()
      const key = getCacheKey(gameInfo)
      if (!key) return null
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([CACHE_STORE_NAME], 'readonly')
        const store = transaction.objectStore(CACHE_STORE_NAME)
        const request = store.get(key)
        
        request.onsuccess = () => {
          if (request.result && request.result.data) {
            // Convert Array back to Uint8Array
            const uint8Array = new Uint8Array(request.result.data)
            const filename = gameInfo.filename || 'game'
            console.log(`Loaded ${filename} from cache (${uint8Array.length} bytes)`)
            resolve(uint8Array)
          } else {
            resolve(null)
          }
        }
        
        request.onerror = () => reject(request.error)
      })
    } catch (err) {
      console.warn('Cache load error:', err)
      return null
    }
  }

  async function saveToCache(gameInfo, fileData) {
    try {
      const db = await initCache()
      const key = getCacheKey(gameInfo)
      if (!key || !fileData) return
      
      const dataArray = Array.from(fileData)
      const gameId = gameInfo.cartridgeId || gameInfo.game_id || 0
      const filename = gameInfo.filename || 'game'
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([CACHE_STORE_NAME], 'readwrite')
        const store = transaction.objectStore(CACHE_STORE_NAME)
        const request = store.put({
          key: key,
          data: dataArray,
          manifestName: filename,
          gameId: gameId,
          timestamp: Date.now()
        })
        
        request.onsuccess = () => {
          console.log(`Saved ${filename} to cache (${fileData.length} bytes)`)
          resolve()
        }
        
        request.onerror = () => reject(request.error)
      })
    } catch (err) {
      console.warn('Cache save error:', err)
    }
  }

  async function clearCache(gameInfo) {
    try {
      const db = await initCache()
      const key = getCacheKey(gameInfo)
      if (!key) return
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([CACHE_STORE_NAME], 'readwrite')
        const store = transaction.objectStore(CACHE_STORE_NAME)
        const request = store.delete(key)
        
        request.onsuccess = () => {
          const filename = gameInfo.filename || 'game'
          console.log(`Cleared cache for ${filename}`)
          resolve()
        }
        
        request.onerror = () => reject(request.error)
      })
    } catch (err) {
      console.warn('Cache clear error:', err)
    }
  }

  async function clearAllCache() {
    try {
      const db = await initCache()
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([CACHE_STORE_NAME], 'readwrite')
        const store = transaction.objectStore(CACHE_STORE_NAME)
        const request = store.clear()
        
        request.onsuccess = () => {
          console.log('Cleared all cache')
          resolve()
        }
        
        request.onerror = () => reject(request.error)
      })
    } catch (err) {
      console.warn('Cache clear all error:', err)
    }
  }

  return {
    loadFromCache,
    saveToCache,
    clearCache,
    clearAllCache
  }
}
