import http from 'node:http'

export function readJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') { resolve({}); return }
      try { resolve(JSON.parse(raw)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

export function requestSignal(req: http.IncomingMessage): AbortSignal {
  const anyReq = req as any
  if (anyReq.signal) return anyReq.signal as AbortSignal
  const controller = new AbortController()
  req.on('close', () => { if (!req.complete) controller.abort() })
  return controller.signal
}
