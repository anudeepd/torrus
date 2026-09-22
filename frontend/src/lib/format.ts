const UNITS = ['KB', 'MB', 'GB', 'TB', 'PB']

/** Human-readable byte size, shared by the file browser and the transfer queue. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  let value = bytes / 1024
  let unit = UNITS[0]
  for (let i = 1; value >= 1024 && i < UNITS.length; i++) {
    value /= 1024
    unit = UNITS[i]
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}
