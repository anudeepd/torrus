import type { Tab } from '@/types'

/** The name a tab would carry on its own, before duplicate disambiguation. */
export function tabBaseName(tab: Tab): string {
  if (tab.label) return tab.label
  if (tab.host && tab.username) {
    return `${tab.type === 'sftp' ? 'SFTP ' : ''}${tab.username}@${tab.host}`
  }
  return tab.type === 'sftp' ? 'SFTP' : 'New Connection'
}

/**
 * The name to show for `tab` among `tabs`. Cloned or duplicated sessions share
 * host, user and label, so identical names are numbered to keep the tab bar,
 * its close buttons and the close confirmation distinguishable.
 */
export function tabDisplayName(tab: Tab, tabs: Tab[] = []): string {
  const name = tabBaseName(tab)
  const sameName = tabs.filter(other => tabBaseName(other) === name)
  if (sameName.length < 2) return name
  return `${name} (${sameName.findIndex(other => other.id === tab.id) + 1})`
}
