// SPDX-License-Identifier: AGPL-3.0-only
// Isolated acceptance fixture only. Its disposable CA is not a product credential.
import { createServer } from 'node:https'
import { request } from 'node:http'
import { readFileSync } from 'node:fs'
createServer(
  { key: readFileSync('/fixture/key.pem'), cert: readFileSync('/fixture/cert.pem') },
  (req, res) => {
    const upstream = request(
      {
        hostname: 'companion',
        port: 5175,
        path: req.url,
        method: req.method,
        headers: req.headers
      },
      (reply) => {
        res.writeHead(reply.statusCode, reply.headers)
        reply.pipe(res)
      }
    )
    upstream.on('error', () => {
      res.writeHead(503)
      res.end('Synthetic companion unavailable')
    })
    req.pipe(upstream)
  }
).listen(8443, '0.0.0.0', () => console.log('Isolated synthetic HTTPS proxy ready'))
