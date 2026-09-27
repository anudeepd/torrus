const UNITS = ['KB', 'MB', 'GB', 'TB', 'PB']

/**
 * Precision varies with magnitude, but the digits and the decimal separator
 * follow the user's locale — `toFixed` would always emit a `.`.
 */
const WHOLE = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const ONE_DECIMAL = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** Human-readable byte size, shared by the file browser and the transfer queue. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${WHOLE.format(bytes)} B`
  let value = bytes / 1024
  let unit = UNITS[0]
  for (let i = 1; value >= 1024 && i < UNITS.length; i++) {
    value /= 1024
    unit = UNITS[i]
  }
  return `${(value >= 10 ? WHOLE : ONE_DECIMAL).format(value)} ${unit}`
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}
