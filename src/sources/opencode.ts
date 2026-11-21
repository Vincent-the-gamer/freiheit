import { getJson } from '../vendor/opencode/http.js'
import { parseListing, buildCatalog } from '../vendor/opencode/catalog.js'
import {
  sessionForConversation,
  endpointFor,
  wireFor,
  applyFingerprint,
  restoreToolName,
  gatewayHeaders,
  CLIENT_UA,
} from '../vendor/opencode/upstream.js'

export const SESSION = sessionForConversation('freiheit')

export async function listOpenCodeModels(): Promise<any[]> {
  const listing = await (getJson as any)('/inference/v1/models', { session: SESSION, attributionUserAgent: 'freiheit' })
  const ids = parseListing(listing)
  return buildCatalog(ids)
}

export function ocEndpoint(model: string): string { return endpointFor(model) }
export function ocWire(model: string): string { return wireFor(model) }
export function ocFingerprint(body: any, wire: string): any {
  const style = wire === 'responses' ? true : wire === 'messages' ? 'claude' : false
  return applyFingerprint(body, style)
}
export { sessionForConversation, gatewayHeaders, CLIENT_UA, restoreToolName }
export { postStreamed } from '../vendor/opencode/http.js'
export { egressFetch } from '../vendor/opencode/egress.js'
