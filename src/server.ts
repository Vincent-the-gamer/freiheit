import http from 'node:http'
import pkgJson from '../package.json'
import { readJson, requestSignal } from './lib/http.js'
import {
  anthropicToChat,
  chatToAnthropicMessage,
  createAnthropicStreamTranslator,
  emitAnthropicMessageAsEvents,
  restoreAnthropicEvent,
  restoreAnthropicMessage,
} from './lib/anthropic.js'
import { listOpenCodeModels, ocEndpoint, ocWire, ocFingerprint, SESSION, postStreamed } from './sources/opencode.js'
import { listKiloModels, postKiloStreamed } from './sources/kilo.js'

const { version: VERSION } = pkgJson

export type ModelSource = 'opencode' | 'kilo'

export interface ModelEntry {
  id: string
  object: 'model'
  created: number
  owned_by: string
  source: ModelSource
  name?: string
  contextWindow?: number
  maxOutput?: number
  vision?: boolean
  reasoning?: boolean
}

export type PublicModel = Omit<ModelEntry, 'source' | 'name' | 'contextWindow' | 'maxOutput' | 'vision' | 'reasoning'>

export interface ServerOptions {
  silent?: boolean
}

const modelCache: ModelEntry[] = []
const CACHE_TTL = 60_000
let cacheExpires = 0

export async function listAllModels(): Promise<ModelEntry[]> {
  if (modelCache.length && Date.now() < cacheExpires) return [...modelCache]
  const out: ModelEntry[] = []
  try { const oc = await listOpenCodeModels(); for (const m of oc) out.push({ id: m.id, object: 'model', created: 0, owned_by: 'opencode', source: 'opencode', name: m.name, contextWindow: m.contextWindow, maxOutput: m.maxOutput, vision: m.vision, reasoning: m.reasoning }) } catch (e) { console.error('opencode list failed', e) }
  try { const kl = await listKiloModels(); for (const m of kl) out.push({ id: m.id, object: 'model', created: 0, owned_by: 'kilo', source: 'kilo', name: m.name, contextWindow: m.contextWindow, maxOutput: m.maxOutput, vision: m.vision, reasoning: m.reasoning }) } catch (e) { console.error('kilo list failed', e) }
  modelCache.splice(0, modelCache.length, ...out)
  cacheExpires = Date.now() + CACHE_TTL
  return out
}

export function toPublicModels(models: ModelEntry[]): PublicModel[] {
  return models.map(({ source, name, contextWindow, maxOutput, vision, reasoning, ...model }) => model)
}

function findSource(model: string): ModelSource | null {
  return modelCache.find((m) => m.id === model)?.source ?? null
}

function sourceFor(model: string): ModelSource {
  return findSource(model) ?? (model.includes('/') ? 'kilo' : 'opencode')
}

function writeJson(res: http.ServerResponse, status: number, body: any) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

function writeSseHeaders(res: http.ServerResponse) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
}

function sseWrite(res: http.ServerResponse, event: string | null, data: string) {
  if (event) res.write(`event: ${event}\n`)
  res.write(`data: ${data}\n\n`)
}

function sseObject(res: http.ServerResponse, event: string, data: any) {
  sseWrite(res, event, JSON.stringify(data))
}

function errorStatus(error: any): number {
  const status = Number(error?.status)
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status
  switch (error?.code) {
    case 'RATE_LIMIT':
    case 'QUOTA_EXHAUSTED':
      return 429
    case 'INVALID_CREDENTIAL':
    case 'AUTHORIZATION_REQUIRED':
      return 401
    case 'PERMISSION_DENIED':
    case 'LANE_LOCKED':
      return 403
    case 'CLIENT_ERROR':
      return 400
    case 'TIMEOUT':
      return 504
    case 'ABORTED':
      return 499
    default:
      return 500
  }
}

function errorMessage(error: any): string {
  return typeof error?.message === 'string' ? error.message : String(error)
}

function anthropicErrorType(error: any): string {
  const status = errorStatus(error)
  if (error?.code === 'RATE_LIMIT' || error?.code === 'QUOTA_EXHAUSTED' || status === 429) return 'rate_limit_error'
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

function anthropicErrorBody(error: any) {
  return {
    type: 'error',
    error: {
      type: anthropicErrorType(error),
      message: errorMessage(error),
    },
  }
}

function openAiErrorBody(error: any) {
  return {
    error: {
      message: errorMessage(error),
      type: 'upstream_error',
    },
  }
}

function restoreNamesDeep(value: any, resolve: (name: string) => string): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) restoreNamesDeep(item, resolve)
    return
  }
  if (value.type === 'function_call' && typeof value.name === 'string') value.name = resolve(value.name)
  for (const key of Object.keys(value)) {
    if (key === 'name') continue
    restoreNamesDeep(value[key], resolve)
  }
}

/** Restore caller tool names in a non-streaming OpenAI/Responses payload. */
function restoreChatPayload(payload: any, resolve: (name: string) => string): any {
  if (!payload || typeof payload !== 'object') return payload
  for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
    const delta = choice?.delta
    if (delta) {
      if (delta.function_call && typeof delta.function_call.name === 'string') {
        delta.function_call.name = resolve(delta.function_call.name)
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        if (call?.function && typeof call.function.name === 'string') call.function.name = resolve(call.function.name)
      }
    }
    const message = choice?.message
    if (message) {
      if (message.function_call && typeof message.function_call.name === 'string') {
        message.function_call.name = resolve(message.function_call.name)
      }
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (call?.function && typeof call.function.name === 'string') call.function.name = resolve(call.function.name)
      }
    }
  }
  restoreNamesDeep(payload, resolve)
  return payload
}

function restoreChatChunk(payload: string, resolve: (name: string) => string): string {
  try {
    return JSON.stringify(restoreChatPayload(JSON.parse(payload), resolve))
  } catch {
    return payload
  }
}

function resolveWith(map: any): (name: string) => string {
  return (name: string) => (map && typeof map.resolve === 'function' ? map.resolve(name) : name)
}

async function handleModels(res: http.ServerResponse) {
  const models = await listAllModels()
  writeJson(res, 200, { object: 'list', data: toPublicModels(models) })
}

async function handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any
  try {
    body = await readJson(req)
  } catch {
    writeJson(res, 400, openAiErrorBody(new Error('invalid JSON body')))
    return
  }

  const model: string = typeof body.model === 'string' ? body.model : ''
  if (model === '') {
    writeJson(res, 400, openAiErrorBody(new Error('model is required')))
    return
  }

  const signal = requestSignal(req)
  const source = sourceFor(model)
  const wantsStream = body.stream === true

  try {
    if (source === 'kilo') {
      if (!wantsStream) {
        let result: any = null
        await postKiloStreamed({ body, signal, onData: (payload: string) => { try { result = JSON.parse(payload) } catch { /* ignore */ } } })
        writeJson(res, 200, result ?? {})
        return
      }
      let headersSent = false
      let doneSent = false
      const emit = (payload: string) => {
        if (!headersSent) { writeSseHeaders(res); headersSent = true }
        sseWrite(res, null, payload)
      }
      try {
        await postKiloStreamed({ body, signal, onData: emit })
        if (!headersSent) { writeSseHeaders(res); headersSent = true }
        if (!doneSent) { res.write('data: [DONE]\n\n'); doneSent = true }
      } catch (error) {
        if (!headersSent) throw error
        sseWrite(res, null, JSON.stringify(openAiErrorBody(error)))
        if (!doneSent) { res.write('data: [DONE]\n\n'); doneSent = true }
      }
      res.end()
      return
    }

    const wire = ocWire(model)
    const path = ocEndpoint(model)
    const renames = ocFingerprint(body, wire)
    const resolve = resolveWith(renames)

    if (!wantsStream) {
      let result: any = null
      await postStreamed({
        path,
        body,
        session: SESSION,
        attributionUserAgent: 'freiheit',
        signal,
        onJson: (payload: any) => { result = payload },
        onData: (payload: string) => { try { result = JSON.parse(payload) } catch { /* ignore */ } },
      })
      if (result === null) throw new Error('upstream returned no body')
      writeJson(res, 200, restoreChatPayload(result, resolve))
      return
    }

    let headersSent = false
    let doneSent = false
    const emit = (payload: string) => {
      if (!headersSent) { writeSseHeaders(res); headersSent = true }
      sseWrite(res, null, restoreChatChunk(payload, resolve))
    }
    try {
      await postStreamed({
        path,
        body,
        session: SESSION,
        attributionUserAgent: 'freiheit',
        signal,
        onData: emit,
        onJson: (payload: any) => emit(JSON.stringify(payload)),
      })
      if (!headersSent) { writeSseHeaders(res); headersSent = true }
      if (!doneSent) { res.write('data: [DONE]\n\n'); doneSent = true }
    } catch (error) {
      if (!headersSent) throw error
      sseWrite(res, null, JSON.stringify(openAiErrorBody(error)))
      if (!doneSent) { res.write('data: [DONE]\n\n'); doneSent = true }
    }
    res.end()
  } catch (error) {
    if (!res.headersSent) writeJson(res, errorStatus(error), openAiErrorBody(error))
    else { try { res.end() } catch { /* already closed */ } }
  }
}

async function handleAnthropicViaChat(options: {
  body: any
  model: string
  source: ModelSource
  signal: AbortSignal
  wantsStream: boolean
  res: http.ServerResponse
}) {
  const { body, model, source, signal, wantsStream, res } = options
  const chatBody = anthropicToChat(body)
  chatBody.stream = wantsStream

  let renames: any = null
  let path = ''
  if (source === 'opencode') {
    const wire = ocWire(model)
    path = ocEndpoint(model)
    renames = ocFingerprint(chatBody, wire)
  }
  const resolve = resolveWith(renames)

  if (!wantsStream) {
    let result: any = null
    const onData = (payload: string) => { try { result = JSON.parse(payload) } catch { /* ignore */ } }
    if (source === 'kilo') await postKiloStreamed({ body: chatBody, signal, onData })
    else await postStreamed({ path, body: chatBody, session: SESSION, attributionUserAgent: 'freiheit', signal, onData, onJson: (payload: any) => { result = payload } })
    if (result === null) throw new Error('upstream returned no body')
    writeJson(res, 200, chatToAnthropicMessage(result, model, resolve))
    return
  }

  let headersSent = false
  const emit = (event: string, data: any) => {
    if (!headersSent) { writeSseHeaders(res); headersSent = true }
    sseObject(res, event, data)
  }
  const translator = createAnthropicStreamTranslator({ model, resolveToolName: resolve, emit })
  try {
    const onData = (payload: string) => translator.push(payload)
    if (source === 'kilo') await postKiloStreamed({ body: chatBody, signal, onData })
    else await postStreamed({ path, body: chatBody, session: SESSION, attributionUserAgent: 'freiheit', signal, onData, onJson: (payload: any) => translator.push(payload) })
    translator.finish()
  } catch (error) {
    if (!headersSent) throw error
    translator.fail(error)
    res.end()
    return
  }
  res.end()
}

async function handleAnthropicNative(options: {
  body: any
  model: string
  signal: AbortSignal
  wantsStream: boolean
  res: http.ServerResponse
}) {
  const { body, model, signal, wantsStream, res } = options
  const renames = ocFingerprint(body, 'messages')
  const resolve = resolveWith(renames)
  const path = ocEndpoint(model)

  if (!wantsStream) {
    let result: any = null
    await postStreamed({
      path,
      body,
      session: SESSION,
      attributionUserAgent: 'freiheit',
      signal,
      onJson: (payload: any) => {
        if (payload?.type === 'error' && payload.error) throw new Error(payload.error.message ?? 'upstream error')
        result = payload
      },
      onData: (payload: string) => { try { result = JSON.parse(payload) } catch { /* ignore */ } },
    })
    if (result === null) throw new Error('upstream returned no body')
    writeJson(res, 200, restoreAnthropicMessage(result, resolve))
    return
  }

  let headersSent = false
  const emitRaw = (event: string | null, data: string) => {
    if (!headersSent) { writeSseHeaders(res); headersSent = true }
    sseWrite(res, event, data)
  }
  const emitObject = (event: string, data: any) => emitRaw(event, JSON.stringify(data))

  try {
    await postStreamed({
      path,
      body,
      session: SESSION,
      attributionUserAgent: 'freiheit',
      signal,
      onEvent: (event: string | null, payload: string) => emitRaw(event, restoreAnthropicEvent(payload, resolve)),
      onJson: (payload: any) => emitAnthropicMessageAsEvents(restoreAnthropicMessage(payload, resolve), emitObject),
    })
  } catch (error) {
    if (!headersSent) throw error
    emitObject('error', anthropicErrorBody(error))
    res.end()
    return
  }
  res.end()
}

async function handleMessages(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any
  try {
    body = await readJson(req)
  } catch {
    writeJson(res, 400, anthropicErrorBody(new Error('invalid JSON body')))
    return
  }

  const model: string = typeof body.model === 'string' ? body.model : ''
  if (model === '') {
    writeJson(res, 400, anthropicErrorBody(new Error('model is required')))
    return
  }

  const signal = requestSignal(req)
  const source = sourceFor(model)
  const wantsStream = body.stream === true

  try {
    if (source === 'kilo') {
      await handleAnthropicViaChat({ body, model, source, signal, wantsStream, res })
      return
    }

    const wire = ocWire(model)
    if (wire === 'messages') {
      await handleAnthropicNative({ body, model, signal, wantsStream, res })
    } else if (wire === 'chat') {
      await handleAnthropicViaChat({ body, model, source, signal, wantsStream, res })
    } else {
      writeJson(res, 400, anthropicErrorBody(new Error(`model ${model} uses the OpenAI Responses wire; /v1/messages supports chat and messages models only`)))
    }
  } catch (error) {
    if (!res.headersSent) writeJson(res, errorStatus(error), anthropicErrorBody(error))
    else {
      try { sseObject(res, 'error', anthropicErrorBody(error)); res.end() } catch { /* already closed */ }
    }
  }
}

export function startServer(port: number, host: string, options: ServerOptions = {}): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    try {
      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) { await handleModels(res); return }
      if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) { await handleChatCompletions(req, res); return }
      if (req.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/messages')) { await handleMessages(req, res); return }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) { writeJson(res, 200, { ok: true, name: 'freiheit', version: VERSION }); return }
      writeJson(res, 404, { error: { message: 'not found', path: url.pathname } })
    } catch (e: any) {
      if (!res.headersSent) writeJson(res, 500, { error: { message: String(e?.message ?? e) } })
      else res.end()
    }
  })

  server.on('error', (e: any) => {
    console.error(`freiheit failed to start: ${String(e?.message ?? e)}`)
    process.exitCode = 1
  })

  server.listen(port, host, () => {
    if (options.silent) return
    console.log(`freiheit v${VERSION} listening on http://${host}:${port}`)
    console.log('Endpoints:')
    console.log('  GET  /v1/models            OpenCode + Kilo free model list')
    console.log('  POST /v1/chat/completions  OpenAI chat (native or translated)')
    console.log('  POST /v1/messages          Anthropic Messages (native or translated)')
    console.log('  GET  /health')
  })
  return server
}
