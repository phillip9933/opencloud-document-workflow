// SPDX-License-Identifier: AGPL-3.0-only
/** Read diagnostic metadata without assuming a caught value is an Error.
 * @param {unknown} error @param {string} property @returns {string|number|undefined}
 */
export function errorProperty(error, property) {
  if (!error || typeof error !== 'object') return undefined
  const value = Reflect.get(error, property)
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}
