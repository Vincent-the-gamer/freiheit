import { fetchKiloListing, postKiloStreamed } from '../vendor/opencode/kilo.js'
import { buildKiloCatalog } from '../vendor/opencode/catalog.js'

export async function listKiloModels(): Promise<any[]> {
  const listing = await fetchKiloListing()
  const rows = Array.isArray(listing?.data) ? listing.data : (Array.isArray(listing) ? listing : [])
  return buildKiloCatalog(rows)
}

export { postKiloStreamed }
export const KILO_BASE = (process.env.OUR_FREE_MODEL_KILO_BASE ?? 'https://ai-gateway.kilo.ai/api/v1').replace(/\/+$/, '')
export function kiloEndpoint() { return '/chat/completions' }
