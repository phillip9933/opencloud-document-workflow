// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from './errors.ts'
import catalog from './language-packs/catalog.json' with { type: 'json' }
export interface LanguagePack {
  id: string
  version: number
  name: string
  dates: string[]
  months: Record<string, number>
  terms: Record<string, string[]>
  eras?: {
    name: string
    offset: number
    start: string
    end: string
    format: string
    firstYear: string
  }[]
  digits?: string[]
  termMatch?: 'word' | 'substring'
  examples: { field: string; quote: string; value: string }[]
}
export interface LanguageProfile {
  packs: LanguagePack[]
}
const validEraBound = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s + 'T00:00:00Z')) &&
  new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s
export function languageProfile(packs: LanguagePack[]): LanguageProfile {
  if (!Array.isArray(packs) || packs.length > 100)
    throw new WorkflowError('VALIDATION_INVALID', 'Invalid language profile')
  const seen = new Set<string>()
  for (const pack of packs) {
    if (
      !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(pack.id) ||
      seen.has(pack.id) ||
      !Number.isInteger(pack.version) ||
      pack.version < 1
    )
      throw new WorkflowError('VALIDATION_INVALID', 'Invalid or duplicate language pack')
    seen.add(pack.id)
    if (pack.termMatch && !['word', 'substring'].includes(pack.termMatch))
      throw new WorkflowError('VALIDATION_INVALID', 'Invalid category matching mode')
    if (
      !Array.isArray(pack.dates) ||
      pack.dates.length > 20 ||
      pack.dates.some((v) => typeof v !== 'string' || v.length > 100)
    )
      throw new WorkflowError('VALIDATION_INVALID', 'Invalid date patterns')
    for (const pattern of pack.dates) {
      const tokens = pattern.match(/\{[^}]+\}/g) || []
      if (
        tokens.filter((t) => t === '{year}').length !== 1 ||
        tokens.filter((t) => t === '{day}').length !== 1 ||
        tokens.filter((t) => t === '{month}' || t === '{monthName}').length !== 1 ||
        tokens.length !== 3
      )
        throw new WorkflowError(
          'VALIDATION_INVALID',
          'Date patterns need year, month and day tokens'
        )
    }
    if (pack.eras) {
      if (!Array.isArray(pack.eras) || pack.eras.length > 50)
        throw new WorkflowError('VALIDATION_INVALID', 'Invalid calendar eras')
      for (const era of pack.eras) {
        if (
          !era.name ||
          era.name.length > 40 ||
          !Number.isInteger(era.offset) ||
          era.offset < 0 ||
          era.offset > 9998 ||
          !validEraBound(era.start) ||
          !validEraBound(era.end) ||
          era.start > era.end ||
          !era.firstYear ||
          era.firstYear.length > 8 ||
          typeof era.format !== 'string' ||
          era.format.length > 100 ||
          ['{era}', '{year}', '{month}', '{day}'].some(
            (token) => era.format.split(token).length !== 2
          ) ||
          era.format.replace(/\{(era|year|month|day)\}/g, '').includes('{')
        )
          throw new WorkflowError('VALIDATION_INVALID', 'Invalid calendar era')
      }
    }
    if (
      pack.digits &&
      (!Array.isArray(pack.digits) ||
        pack.digits.length > 10 ||
        pack.digits.some(
          (d) =>
            typeof d !== 'string' ||
            Array.from(d).length !== 10 ||
            new Set(Array.from(d)).size !== 10
        ))
    )
      throw new WorkflowError(
        'VALIDATION_INVALID',
        'Digit sets must contain ten distinct decimal digits'
      )
    if (pack.dates.some((p) => p.includes('{monthName}')) && !Object.keys(pack.months).length)
      throw new WorkflowError('VALIDATION_INVALID', 'Named-month rules need month aliases')
    for (const [name, month] of Object.entries(pack.months)) {
      if (!name || name.length > 60 || !Number.isInteger(month) || month < 1 || month > 12)
        throw new WorkflowError('VALIDATION_INVALID', 'Invalid month alias')
    }
    for (const [id, terms] of Object.entries(pack.terms)) {
      if (
        !id.trim() ||
        id.length > 150 ||
        /[\x00-\x1f\x7f]/.test(id) ||
        !Array.isArray(terms) ||
        terms.length > 100 ||
        terms.some((t) => typeof t !== 'string' || !t.trim() || t.length > 100)
      )
        throw new WorkflowError('VALIDATION_INVALID', 'Invalid category terms')
    }
  }
  return { packs: JSON.parse(JSON.stringify(packs)) as LanguagePack[] }
}
export const defaultLanguageProfile = languageProfile(catalog as unknown as LanguagePack[])
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const dateLiteral = (s: string, profile: LanguageProfile) =>
  escape(normalize(s, profile)).replace(/\s+/gu, '\\s+')
// Unicode decimal blocks allow localized digits without changing the preserved source fact.
const zeroes = [
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xe50,
  0xed0, 0xf20, 0x1040, 0x17e0, 0x1810, 0xff10
]
function normalize(s: string, profile = defaultLanguageProfile) {
  const custom = Object.fromEntries(
    profile.packs.flatMap((p) =>
      (p.digits || []).flatMap((set) =>
        Array.from(set).map((digit, n) => [digit.normalize('NFKC'), String(n)])
      )
    )
  )
  return Array.from(s.normalize('NFKC'))
    .map((c) => {
      if (custom[c] !== undefined) return custom[c]
      const n = c.codePointAt(0)!
      const zero = zeroes.find((z) => n >= z && n < z + 10)
      return zero === undefined ? c : String(n - zero)
    })
    .join('')
    .toLowerCase()
}
export function printedDateISO(raw: string, profile = defaultLanguageProfile): string {
  const candidates = new Set<string>()
  let matched = false
  for (const pack of profile.packs) {
    for (const era of pack.eras ?? []) {
      const fields: string[] = []
      let regex = '',
        last = 0
      for (const token of era.format.matchAll(/\{(era|year|month|day)\}/g)) {
        regex += escape(normalize(era.format.slice(last, token.index), profile).replace(/\s/gu, ''))
        fields.push(token[1]!)
        regex +=
          token[1] === 'era'
            ? '(' + escape(normalize(era.name, profile)) + ')'
            : token[1] === 'year'
              ? '([0-9]{1,3}|' + escape(normalize(era.firstYear, profile)) + ')'
              : '([0-9]{1,2})'
        last = token.index + token[0].length
      }
      regex += escape(normalize(era.format.slice(last), profile).replace(/\s/gu, ''))
      const match = new RegExp('^' + regex + '$', 'u').exec(
        normalize(raw, profile).replace(/\s/gu, '')
      )
      if (!match) continue
      matched = true
      const values: Record<string, number> = {}
      fields.forEach((field, i) => {
        if (field !== 'era')
          values[field] =
            field === 'year' && match[i + 1] === normalize(era.firstYear, profile)
              ? 1
              : Number(match[i + 1])
      })
      const year = values.year! + era.offset,
        iso = `${String(year).padStart(4, '0')}-${String(values.month).padStart(2, '0')}-${String(values.day).padStart(2, '0')}`,
        date = new Date(iso + 'T00:00:00Z')
      if (
        values.year! >= 1 &&
        year <= 9999 &&
        Number.isFinite(date.getTime()) &&
        date.toISOString().slice(0, 10) === iso &&
        iso >= era.start &&
        iso <= era.end
      )
        candidates.add(iso)
    }
    const months = Object.fromEntries(
      Object.entries(pack.months).map(([name, n]) => [normalize(name, profile), n])
    )
    for (const pattern of pack.dates) {
      const fields: string[] = []
      let regex = '',
        last = 0
      for (const token of pattern.matchAll(/\{(year|month|day|monthName)\}/g)) {
        regex += dateLiteral(pattern.slice(last, token.index), profile)
        const field = token[1]!
        fields.push(field)
        regex +=
          field === 'monthName'
            ? '(' +
              Object.keys(months)
                .sort((a, b) => b.length - a.length)
                .map(escape)
                .join('|') +
              ')'
            : field === 'year'
              ? '([0-9]{4})'
              : '([0-9]{1,2})'
        last = token.index + token[0].length
      }
      regex += dateLiteral(pattern.slice(last), profile)
      const match = new RegExp('^' + regex + '$', 'u').exec(normalize(raw, profile).trim())
      if (!match) continue
      matched = true
      const values: Record<string, number> = {}
      fields.forEach((f, i) => {
        values[f === 'monthName' ? 'month' : f] =
          f === 'monthName' ? months[match[i + 1]!]! : Number(match[i + 1])
      })
      const iso = `${String(values.year).padStart(4, '0')}-${String(values.month).padStart(2, '0')}-${String(values.day).padStart(2, '0')}`
      const date = new Date(iso + 'T00:00:00Z')
      if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso)
        candidates.add(iso)
    }
  }
  if (candidates.size > 1)
    throw new WorkflowError(
      'DATE_AMBIGUOUS',
      'Ambiguous printed date; review the date convention explicitly'
    )
  if (!candidates.size)
    throw new WorkflowError(
      matched ? 'DATE_INVALID' : 'DATE_UNSUPPORTED',
      matched
        ? 'Invalid calendar date'
        : 'Unsupported printed date format; add an explicit language/date rule'
    )
  return [...candidates][0]!
}
// Locate possible complete date spans using the configured formats, without
// assigning an interpretation. Callers must restore the actual source span and
// pass it through printedDateISO, which still rejects ambiguity/invalid dates.
export function dateSearchCandidates(raw: string, profile = defaultLanguageProfile): string[] {
  const source = normalize(raw, profile),
    found = new Set<string>()
  const literal = (value: string) =>
    Array.from(normalize(value, profile).replace(/\s/gu, '')).map(escape).join('\\s*')
  const shortNumber = '[0-9](?:\\s*[0-9])?'
  for (const pack of profile.packs) {
    const months = Object.keys(pack.months)
      .sort((a, b) => b.length - a.length)
      .map(literal)
      .join('|')
    const formats = [
      ...pack.dates.map((format) => ({
        format,
        tokens: {
          year: '[0-9](?:\\s*[0-9]){3}',
          month: shortNumber,
          day: shortNumber,
          monthName: months ? '(?:' + months + ')' : '(?!)'
        } as Record<string, string>
      })),
      ...(pack.eras ?? []).map((era) => ({
        format: era.format,
        tokens: {
          era: literal(era.name),
          year: '(?:[0-9](?:\\s*[0-9]){0,2}|' + literal(era.firstYear) + ')',
          month: shortNumber,
          day: shortNumber
        } as Record<string, string>
      }))
    ]
    for (const { format, tokens } of formats) {
      const parts: string[] = []
      let last = 0
      for (const token of format.matchAll(/\{(era|year|month|day|monthName)\}/g)) {
        const before = literal(format.slice(last, token.index))
        if (before) parts.push(before)
        parts.push(tokens[token[1]!]!)
        last = token.index + token[0].length
      }
      const after = literal(format.slice(last))
      if (after) parts.push(after)
      const regex = parts.join('\\s*')
      // Keep whitespace boundaries: removing them can join a day to the following
      // time, or combine unrelated numeric runs into a fabricated date candidate.
      for (const match of source.matchAll(new RegExp('(?<![0-9])' + regex + '(?![0-9])', 'gu'))) {
        found.add(match[0].trim())
        if (found.size > 100) return []
      }
    }
  }
  return [...found]
}
// Printed CJK headings are often spaced glyph-by-glyph by PDF extraction.
// This changes spacing only, within one quotation line; words and digits are
// never joined across unrelated lines or evidence passages.
export function layoutSubstringSupported(cue: string, quotes: string[]): boolean {
  const compact = cue.replace(/[\p{Zs}\t]/gu, '')
  if (
    !/^[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]{2,}$/u.test(
      compact
    )
  )
    return false
  const pattern = new RegExp(Array.from(compact).map(escape).join('[\\p{Zs}\\t]{0,32}'), 'u')
  return quotes.some((quote) =>
    quote.split(/[\r\n\u2028\u2029]/).some((line) => pattern.test(line))
  )
}
export function categorySupported(id: string, quotes: string[], profile = defaultLanguageProfile) {
  const normalizedQuotes = quotes.map((quote) => normalize(quote, profile)),
    text = normalizedQuotes.join(' ')
  return profile.packs.some((pack) =>
    (pack.terms[id] || []).some((term) => {
      const cue = normalize(term, profile)
      return pack.termMatch === 'substring'
        ? text.includes(cue) || layoutSubstringSupported(cue, normalizedQuotes)
        : new RegExp(
            '(?<![\\p{L}\\p{N}\\p{M}])' + escape(cue) + '(?![\\p{L}\\p{N}\\p{M}])',
            'u'
          ).test(text)
    })
  )
}
export function languageInstructions(profile = defaultLanguageProfile) {
  return JSON.stringify({
    dateFormats: [...new Set(profile.packs.flatMap((p) => p.dates))],
    calendarEras: profile.packs.flatMap((p) => p.eras ?? []),
    categoryTerms: profile.packs.map((p) => ({ locale: p.id, terms: p.terms })),
    fieldExamples: profile.packs.flatMap((p) => p.examples)
  })
}
