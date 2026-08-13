export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
}

export const isMac = isMacPlatform()

export const modKey = isMac ? '⌘' : 'Ctrl'
