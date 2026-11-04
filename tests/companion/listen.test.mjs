// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listenAddress } from '../../companion/listen.mjs'
test('the listener defaults to loopback and a container listener requires two explicit live settings', () => {
  assert.equal(listenAddress({}, 'demo'), '127.0.0.1')
  assert.equal(listenAddress({}, 'live'), '127.0.0.1')
  assert.throws(() => listenAddress({ WORKFLOW_LISTEN_ADDRESS: '0.0.0.0' }, 'live'))
  assert.throws(() =>
    listenAddress({ WORKFLOW_LISTEN_ADDRESS: '0.0.0.0', WORKFLOW_PRIVATE_NETWORK: 'true' }, 'demo')
  )
  assert.equal(
    listenAddress({ WORKFLOW_LISTEN_ADDRESS: '0.0.0.0', WORKFLOW_PRIVATE_NETWORK: 'true' }, 'live'),
    '0.0.0.0'
  )
  assert.throws(() => listenAddress({ WORKFLOW_LISTEN_ADDRESS: '192.168.50.25' }, 'live'))
})
