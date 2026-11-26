/**
 * xterm builds its DOM renderer styles with `document.createElement('style')`.
 * A nonce-based CSP rejects those unless the element carries the page nonce
 * before it is inserted. The server replaces the meta placeholder per request.
 */
export function installStyleNonce(doc: Document = document): void {
  const nonce = doc.querySelector<HTMLMetaElement>('meta[name="csp-style-nonce"]')?.content
  if (!nonce) return

  const createElement = doc.createElement.bind(doc)
  doc.createElement = ((tagName: string, options?: ElementCreationOptions) => {
    const element = createElement(tagName, options)
    if (tagName.toLowerCase() === 'style') element.setAttribute('nonce', nonce)
    return element
  }) as typeof doc.createElement
}
