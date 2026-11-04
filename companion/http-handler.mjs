// SPDX-License-Identifier: AGPL-3.0-only
export function handleRequest(handler) {
  return async (request, response) => {
    try {
      await handler(request, response)
    } catch {
      // A partial response cannot be replaced. End the connection instead of
      // throwing ERR_HTTP_HEADERS_SENT from an async server event listener.
      if (response.headersSent || response.writableEnded || response.destroyed) {
        if (!response.writableEnded) response.destroy()
        return
      }
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end('Not found')
    }
  }
}
