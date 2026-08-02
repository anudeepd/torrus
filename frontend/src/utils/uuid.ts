export function uuid(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  if (typeof cryptoApi?.getRandomValues === 'function') {
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, character =>
      (+character ^ cryptoApi.getRandomValues(new Uint8Array(1))[0] & 15 >> +character / 4).toString(16))
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
