// SPDX-License-Identifier: AGPL-3.0-only
import { computed, inject, onBeforeUnmount, provide, ref } from 'vue'
import type { InjectionKey } from 'vue'
import en from '../locales/en.json'
import ja from '../locales/ja.json'
import es from '../locales/es.json'
import fr from '../locales/fr.json'
import de from '../locales/de.json'
export const uiLanguages = [
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' }
] as const
export type UILanguage = (typeof uiLanguages)[number]['id']
export type LanguagePreference = UILanguage | 'auto'
const catalogs: Record<UILanguage, Record<string, string>> = { en, ja, es, fr, de }
const storageKey = 'document-workflow:language'
const supported = (value: unknown): UILanguage | undefined => {
  if (typeof value !== 'string') return
  const id = value.toLowerCase().split(/[-_]/)[0]
  return uiLanguages.find((language) => language.id === id)?.id
}
const preferenceValue = (value: unknown): LanguagePreference =>
  value === 'auto' || uiLanguages.some((language) => language.id === value)
    ? (value as LanguagePreference)
    : 'auto'
export const hostLocaleKey: InjectionKey<() => string> = Symbol('OpenCloud UI language')
export function createLocale({
  host = () => '',
  listen = true
}: { host?: () => string; listen?: boolean } = {}) {
  const preference = ref<LanguagePreference>('auto'),
    system = ref<string[]>(
      typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? [navigator.language])]
    )
  try {
    preference.value = preferenceValue(globalThis.localStorage?.getItem(storageKey))
  } catch {
    /* Storage may be unavailable; retain the system language default. */
  }
  const locale = computed<UILanguage>(() =>
    preference.value !== 'auto'
      ? preference.value
      : (supported(host()) ?? system.value.map(supported).find(Boolean) ?? 'en')
  )
  function set(value: unknown) {
    preference.value = preferenceValue(value)
    try {
      globalThis.localStorage?.setItem(storageKey, preference.value)
    } catch {
      /* Keep the in-memory selection when browser storage is unavailable. */
    }
  }
  function t(message: string, parameters: Record<string, string | number> = {}) {
    const translated = catalogs[locale.value][message] ?? message
    return translated.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (original, key) =>
      parameters[key] === undefined
        ? original
        : typeof parameters[key] === 'number'
          ? new Intl.NumberFormat(locale.value).format(parameters[key])
          : String(parameters[key])
    )
  }
  function formatDate(value: string | number) {
    const date = new Date(value)
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(
          date
        )
      : String(value)
  }
  const languageChanged = () => {
    system.value = [...(navigator.languages ?? [navigator.language])]
  }
  const storageChanged = (event: StorageEvent) => {
    if (event.key === storageKey) preference.value = preferenceValue(event.newValue)
  }
  if (listen && typeof window !== 'undefined') {
    window.addEventListener('languagechange', languageChanged)
    window.addEventListener('storage', storageChanged)
  }
  const dispose = () => {
    if (listen && typeof window !== 'undefined') {
      window.removeEventListener('languagechange', languageChanged)
      window.removeEventListener('storage', storageChanged)
    }
  }
  return { preference, locale, set, t, formatDate, dispose }
}
export type UILocale = ReturnType<typeof createLocale>
export const localeKey: InjectionKey<UILocale> = Symbol('Document Workflow UI locale')
export function provideLocale() {
  const state = createLocale({ host: inject(hostLocaleKey, () => '') })
  provide(localeKey, state)
  onBeforeUnmount(state.dispose)
  return state
}
let fallback: UILocale | undefined
export function useLocale() {
  return inject(localeKey, null) ?? (fallback ??= createLocale({ listen: false }))
}
export { catalogs }
