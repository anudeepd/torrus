export const isMac = typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)

export const modKey = isMac ? '⌘' : 'Ctrl'
