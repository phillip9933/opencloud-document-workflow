// SPDX-License-Identifier: AGPL-3.0-only
export type TagDiscoveryMode = 'off' | 'existing' | 'create'
export interface TagDiscovery {
  mode: Exclude<TagDiscoveryMode, 'off'>
  catalog: string[]
}
export function tagName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 80 ||
    value !== value.normalize('NFC') ||
    /[\x00-\x1f\x7f,]/.test(value)
  )
    throw new Error('Invalid discovered tag name')
  return value
}
export const tagKey = (value: string) =>
  value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
export function tagCatalog(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > 5000)
    throw new Error('Tag directory exceeds the supported review size')
  const result: string[] = [],
    keys = new Set<string>()
  for (const value of values) {
    const name = tagName(value),
      key = tagKey(name)
    if (!keys.has(key)) {
      keys.add(key)
      result.push(name)
    }
  }
  return result.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
export function validateTagDiscovery(value: unknown): TagDiscovery {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'catalog,mode'
  )
    throw new Error('Invalid tag discovery snapshot')
  const v = value as TagDiscovery
  if (!['existing', 'create'].includes(v.mode)) throw new Error('Invalid tag discovery mode')
  return { mode: v.mode, catalog: tagCatalog(v.catalog) }
}
export function canonicalTag(value: string, discovery?: TagDiscovery): string {
  tagName(value)
  return discovery?.catalog.find((tag) => tagKey(tag) === tagKey(value)) ?? value
}
export function discoveredTagAllowed(value: string, discovery?: TagDiscovery): boolean {
  if (!discovery) return false
  tagName(value)
  return (
    discovery.mode === 'create' || discovery.catalog.some((tag) => tagKey(tag) === tagKey(value))
  )
}
