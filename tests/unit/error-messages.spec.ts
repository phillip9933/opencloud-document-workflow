// SPDX-License-Identifier: AGPL-3.0-only
import { catalogs, createLocale } from '../../src/state/locale'
import { errorMessageKeys, errorMessageKey } from '../../src/domain/error-messages'
import { createWorkspace } from '../../src/state/workspace'
it('provides translations for typed backend errors in every supported locale', () => {
  for (const key of errorMessageKeys)
    for (const locale of ['en', 'ja', 'es', 'fr', 'de'] as const)
      expect(catalogs[locale][key], `${locale}: ${key}`).toBeTruthy()
  expect(errorMessageKey('__proto__')).toBeUndefined()
  expect(errorMessageKey('unrecognized')).toBeUndefined()
})
it('translates held-operation wrappers and remote status without translating document values', () => {
  const locale = createLocale({ listen: false })
  try {
    locale.set('ja')
    expect(locale.t('Operation held. Invalid request')).toBe(
      '操作を保留しました。リクエストが無効です'
    )
    expect(locale.t('OpenCloud HTTP 403')).toBe('OpenCloudがHTTP 403を返しました。')
    expect(locale.t('Synthetic.pdf')).toBe('Synthetic.pdf')
  } finally {
    locale.dispose()
    localStorage.clear()
  }
})
it('maps stable error codes without losing the no-Trash-intent guarantee', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'Changed English wording',
            code: 'WORKFLOW_BUSY',
            trashRecorded: false
          }),
          { status: 409 }
        )
    )
  )
  try {
    const store = createWorkspace()
    await expect(store.request('document-trash', {})).rejects.toMatchObject({
      message: 'This document is busy. Wait for its current operation to finish.',
      trashRecorded: false
    })
    await expect(store.request('metadata-save', {})).rejects.not.toHaveProperty('trashRecorded')
  } finally {
    vi.unstubAllGlobals()
  }
})
