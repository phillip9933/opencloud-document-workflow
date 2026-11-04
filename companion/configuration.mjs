// SPDX-License-Identifier: AGPL-3.0-only
import { WorkflowError } from '../src/domain/errors.ts'
import { validateSpace } from '../src/domain/review.ts'
import { defaultFilingRules, validateFilingRules } from '../src/domain/filing.ts'
export const defaultLimits = () => ({
  maxMiB: 100,
  maxPages: 1000,
  maxCharacters: 1000000,
  documentsPerCycle: 20,
  contextTokens: 32768
})
/** @param {unknown} value @returns {import('./contracts.d.mts').ProcessingLimits} */
export function validateLimits(value) {
  const bounds = {
    maxMiB: [1, 1024],
    maxPages: [1, 10000],
    maxCharacters: [1000, 8000000],
    documentsPerCycle: [1, 1000],
    contextTokens: [8192, 1048576]
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkflowError('VALIDATION_INVALID', 'Invalid processing capacity settings')
  const record = /** @type {Record<string,unknown>} */ (value)
  if (
    Object.keys(record).sort().join(',') !== Object.keys(bounds).sort().join(',') ||
    Object.entries(bounds).some(
      ([key, [min, max]]) =>
        typeof record[key] !== 'number' ||
        !Number.isInteger(record[key]) ||
        record[key] < min ||
        record[key] > max
    )
  ) {
    throw new WorkflowError('VALIDATION_INVALID', 'Invalid processing capacity settings')
  }
  return structuredClone(/** @type {import('./contracts.d.mts').ProcessingLimits} */ (value))
}
export class Configuration {
  /** @param {import('./contracts.d.mts').ConfigurationOwner} workflow */
  constructor(workflow) {
    this.w = workflow
    this.db = workflow.db
  }
  /** @param {import('./contracts.d.mts').Actor} actor */
  settings(actor) {
    const row = this.db
      .prepare('select * from processing_settings where scope=?')
      .get(this.w.scope(actor))
    return row
      ? {
          rules: validateFilingRules(JSON.parse(String(row.rules))),
          limits: validateLimits({ ...defaultLimits(), ...JSON.parse(String(row.limits)) })
        }
      : { rules: defaultFilingRules(), limits: defaultLimits() }
  }
  /** @param {import('./contracts.d.mts').Actor} actor @returns {string} */
  destinationSpace(actor) {
    return validateSpace(
      this.db.prepare('select space from filing_locations where scope=?').get(this.w.scope(actor))
        ?.space ?? actor.space
    )
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {unknown} space */
  saveDestination(actor, space) {
    const checked = validateSpace(space)
    this.db
      .prepare(
        'insert into filing_locations values(?,?) on conflict(scope) do update set space=excluded.space'
      )
      .run(this.w.scope(actor), checked)
    this.w.event(actor, null, 'destination_space_saved', { space: checked })
  }
  /** @param {import('./contracts.d.mts').Actor} actor @param {{rules:unknown,limits:unknown}} input */
  save(actor, { rules, limits }) {
    const checkedRules = validateFilingRules(rules)
    const checkedLimits = validateLimits(limits)
    const inbox = this.db
      .prepare('select value from intake_settings where scope=?')
      .get(this.w.scope(actor))
    if (inbox) {
      const current = JSON.parse(String(inbox.value))
      if (
        this.destinationSpace(actor) === actor.space &&
        current.enabled &&
        (current.folder === checkedRules.root || current.folder.startsWith(checkedRules.root + '/'))
      )
        throw new WorkflowError(
          'OPERATION_HELD',
          'Pause ingestion and select an inbox outside the filing destination first'
        )
    }
    this.db
      .prepare(
        'insert into processing_settings values(?,?,?) on conflict(scope) do update set rules=excluded.rules,limits=excluded.limits'
      )
      .run(this.w.scope(actor), JSON.stringify(checkedRules), JSON.stringify(checkedLimits))
    this.w.event(actor, null, 'filing_rules_saved')
    return { rules: checkedRules, limits: checkedLimits }
  }
}
