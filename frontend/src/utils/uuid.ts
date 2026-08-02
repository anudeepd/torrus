export function uuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  if (globalThis.crypto?.getRandomValues) {
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, character =>
      (+character ^ globalThis.crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> +character / 4).toString(16))
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
