// SPDX-License-Identifier: AGPL-3.0-only
import type { Bundle, Claim } from './review.ts'
const claim = (value: string, quote = value): Claim => ({ value, evidence: [{ page: 1, quote }] })
export function samples(): Bundle[] {
  const source = (name: string, hash: string) => ({
    server: 'https://opencloud.example',
    account: 'synthetic-user',
    space: 'synthetic-space',
    resourceId: name,
    path: `Inbox/${name}.pdf`,
    etag: '"sample-v1"',
    sha256: hash.repeat(64)
  })
  return [
    {
      schemaVersion: 1,
      source: source('electricity', 'a'),
      pages: [
        'SYNTHETIC DOCUMENT\nIssuer: Example Electricity Company\nDocument type: Electricity invoice\nIssue date: 2026-10-29\n'
      ],
      proposal: {
        issuer: claim('Example Electricity Company'),
        date: claim('2026-10-29'),
        kind: claim('Electricity invoice'),
        folder: claim('Utilities/Electricity', 'Electricity invoice'),
        tags: [
          claim('Electricity', 'Electricity invoice'),
          claim('Invoice', 'Electricity invoice'),
          claim('Synthetic', 'SYNTHETIC DOCUMENT'),
          claim('Japanese', 'Electricity invoice')
        ]
      }
    },
    {
      schemaVersion: 1,
      source: source('water', 'b'),
      pages: [
        '合成テスト文書\n発行者：飯山市上下水道事業\n書類種類：水道料金請求書\n発行日：2026年10月29日'
      ],
      proposal: {
        issuer: claim('飯山市上下水道事業'),
        date: claim('2026年10月29日'),
        kind: claim('水道料金請求書'),
        folder: claim('Utilities/Water', '水道料金請求書'),
        tags: [claim('Water', '水道料金請求書'), claim('Synthetic', '合成テスト文書')]
      }
    },
    { schemaVersion: 1, source: source('image-only', 'c'), pages: [''], proposal: null }
  ]
}
