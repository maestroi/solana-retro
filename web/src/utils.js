export function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

export function formatHash(hash) {
  if (!hash) return ''
  // Show first 8 and last 8 characters with ellipsis in between
  if (hash.length > 20) {
    return `${hash.substring(0, 8)}...${hash.substring(hash.length - 8)}`
  }
  return hash
}

export function formatAddress(address) {
  if (!address) return ''
  // Show first 8 and last 8 characters with ellipsis in between
  if (address.length > 20) {
    return `${address.substring(0, 8)}...${address.substring(address.length - 8)}`
  }
  return address
}

export function formatTimeRemaining(seconds) {
  if (!seconds || !isFinite(seconds)) return 'Calculating...'
  
  if (seconds < 60) {
    return `${Math.round(seconds)}s`
  } else if (seconds < 3600) {
    const mins = Math.floor(seconds / 60)
    const secs = Math.round(seconds % 60)
    return `${mins}m ${secs}s`
  } else {
    const hours = Math.floor(seconds / 3600)
    const mins = Math.floor((seconds % 3600) / 60)
    return `${hours}h ${mins}m`
  }
}
