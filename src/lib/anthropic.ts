import { randomUUID } from 'node:crypto'

/**
 * Anthropic Messages <-> OpenAI chat conversion.
 *
 * The gateway accepts Anthropic-shaped requests on `/v1/messages`, but most
 * free models are served over the OpenAI chat wire. This module is the seam:
 * it turns a Messages request into a chat body, and turns the chat answer
 * (streamed or not) back into Anthropic messages and SSE events.
 */

export type ToolNameResolver = (name: string) => string

export interface AnthropicStreamTranslator {
  push(payload: unknown): void
  finish(): void
  fail(error: unknown): void
}

interface ToolState {
  index: number
  id: string
  name: string
  started: boolean
  buffered: string
}

function generatedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && (part as any).type === 'text' && typeof (part as any).text === 'string') {
        return (part as any).text
      }
      return ''
    })
    .filter((part) => part !== '')
    .join('\n')
}

function imageUrl(source: any): string | null {
  if (!source || typeof source !== 'object') return null
  if (source.type === 'base64' && typeof source.data === 'string') {
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png'
    return `data:${mediaType};base64,${source.data}`
  }
  if (source.type === 'url' && typeof source.url === 'string') return source.url
  return null
}

function parseToolInput(value: unknown): any {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || value.trim() === '') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function mapStopReason(reason: unknown): string {
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    case 'stop':
    default:
      return 'end_turn'
  }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && typeof (part as any).text === 'string') return (part as any).text
      return ''
    })
    .join('')
}

function resolveName(resolve: ToolNameResolver | undefined, name: unknown): string {
  const value = typeof name === 'string' ? name : ''
  return resolve ? resolve(value) : value
}

/** Convert one Anthropic Messages request body into an OpenAI chat body. */
export function anthropicToChat(input: any): any {
  const source = input && typeof input === 'object' ? input : {}
  const body: any = { model: source.model }

  if (typeof source.max_tokens === 'number') body.max_tokens = source.max_tokens
  if (typeof source.temperature === 'number') body.temperature = source.temperature
  if (typeof source.top_p === 'number') body.top_p = source.top_p
  if (Array.isArray(source.stop_sequences) && source.stop_sequences.length > 0) body.stop = source.stop_sequences
  else if (typeof source.stop_sequences === 'string') body.stop = source.stop_sequences
  if (source.stream === true) body.stream = true
  if (body.stream === true) body.stream_options = { include_usage: true }

  const messages: any[] = []
  const system = textOf(source.system)
  if (system.trim() !== '') messages.push({ role: 'system', content: system })

  for (const message of Array.isArray(source.messages) ? source.messages : []) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user'
    const content = message?.content

    if (typeof content === 'string') {
      messages.push({ role, content })
      continue
    }
    if (!Array.isArray(content)) {
      messages.push({ role, content: '' })
      continue
    }

    if (role === 'assistant') {
      const texts: string[] = []
      const toolCalls: any[] = []
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          texts.push(block.text)
        } else if (block?.type === 'tool_use') {
          toolCalls.push({
            id: typeof block.id === 'string' && block.id !== '' ? block.id : generatedId('call'),
            type: 'function',
            function: {
              name: String(block.name ?? ''),
              arguments: JSON.stringify(block.input ?? {}),
            },
          })
        }
      }
      const assembled: any = { role: 'assistant', content: texts.length > 0 ? texts.join('\n') : null }
      if (toolCalls.length > 0) assembled.tool_calls = toolCalls
      messages.push(assembled)
      continue
    }

    const parts: any[] = []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text })
      } else if (block?.type === 'image') {
        const url = imageUrl(block.source)
        if (url !== null) parts.push({ type: 'image_url', image_url: { url } })
      } else if (block?.type === 'tool_result') {
        const toolText = textOf(block.content)
        messages.push({
          role: 'tool',
          tool_call_id: String(block.tool_use_id ?? ''),
          content: toolText !== '' ? toolText : (block.is_error === true ? 'Tool execution failed.' : ''),
        })
      }
    }
    if (parts.length > 0) {
      if (parts.every((part) => part.type === 'text')) {
        messages.push({ role: 'user', content: parts.map((part) => part.text).join('\n') })
      } else {
        messages.push({ role: 'user', content: parts })
      }
    }
  }
  body.messages = messages

  if (Array.isArray(source.tools) && source.tools.length > 0) {
    const tools = source.tools
      .filter((tool: any) => tool && typeof tool.name === 'string' && tool.name !== '')
      .map((tool: any) => ({
        type: 'function',
        function: {
          name: tool.name,
          ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
          parameters: tool.input_schema ?? { type: 'object', properties: {} },
        },
      }))
    if (tools.length > 0) body.tools = tools
  }

  const choice = source.tool_choice
  if (choice && typeof choice === 'object') {
    if (choice.type === 'auto') body.tool_choice = 'auto'
    else if (choice.type === 'any') body.tool_choice = 'required'
    else if (choice.type === 'none') body.tool_choice = 'none'
    else if (choice.type === 'tool' && typeof choice.name === 'string') {
      body.tool_choice = { type: 'function', function: { name: choice.name } }
    }
  }

  return body
}

/** Convert one non-streaming OpenAI chat completion into an Anthropic message. */
export function chatToAnthropicMessage(payload: any, model: string, resolve?: ToolNameResolver): any {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : undefined
  const message = choice?.message ?? {}
  const content: any[] = []

  if (typeof message.content === 'string' && message.content !== '') {
    content.push({ type: 'text', text: message.content })
  } else if (Array.isArray(message.content)) {
    const text = contentText(message.content)
    if (text !== '') content.push({ type: 'text', text })
  }

  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    content.push({
      type: 'tool_use',
      id: typeof call?.id === 'string' && call.id !== '' ? call.id : generatedId('toolu'),
      name: resolveName(resolve, call?.function?.name),
      input: parseToolInput(call?.function?.arguments),
    })
  }

  if (message.function_call && typeof message.function_call === 'object') {
    content.push({
      type: 'tool_use',
      id: generatedId('toolu'),
      name: resolveName(resolve, message.function_call.name),
      input: parseToolInput(message.function_call.arguments),
    })
  }

  return {
    id: typeof payload?.id === 'string' && payload.id !== '' ? payload.id : generatedId('msg'),
    type: 'message',
    role: 'assistant',
    model: typeof payload?.model === 'string' && payload.model !== '' ? payload.model : model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: typeof payload?.usage?.prompt_tokens === 'number' ? payload.usage.prompt_tokens : 0,
      output_tokens: typeof payload?.usage?.completion_tokens === 'number' ? payload.usage.completion_tokens : 0,
    },
  }
}

/** Restore caller tool names in a non-streaming Anthropic message. */
export function restoreAnthropicMessage(message: any, resolve?: ToolNameResolver): any {
  if (!resolve || !message || !Array.isArray(message.content)) return message
  for (const block of message.content) {
    if (block?.type === 'tool_use' && typeof block.name === 'string') block.name = resolve(block.name)
  }
  return message
}

/** Restore caller tool names in one Anthropic SSE `data:` payload. */
export function restoreAnthropicEvent(payload: string, resolve?: ToolNameResolver): string {
  if (!resolve) return payload
  try {
    const event = JSON.parse(payload)
    if (event?.type === 'content_block_start'
      && event.content_block?.type === 'tool_use'
      && typeof event.content_block.name === 'string') {
      event.content_block.name = resolve(event.content_block.name)
    }
    return JSON.stringify(event)
  } catch {
    return payload
  }
}

/** Emit one complete Anthropic message as the event sequence a streaming client expects. */
export function emitAnthropicMessageAsEvents(message: any, emit: (event: string, data: any) => void): void {
  const usage = message?.usage ?? {}
  emit('message_start', {
    type: 'message_start',
    message: {
      ...message,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0, output_tokens: 0 },
    },
  })

  const content = Array.isArray(message?.content) ? message.content : []
  content.forEach((block: any, index: number) => {
    if (block?.type === 'text') {
      emit('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      })
      emit('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: String(block.text ?? '') },
      })
      emit('content_block_stop', { type: 'content_block_stop', index })
    } else if (block?.type === 'tool_use') {
      emit('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      })
      emit('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
      })
      emit('content_block_stop', { type: 'content_block_stop', index })
    }
  })

  emit('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message?.stop_reason ?? 'end_turn', stop_sequence: null },
    usage: {
      ...(typeof usage.input_tokens === 'number' ? { input_tokens: usage.input_tokens } : {}),
      output_tokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
    },
  })
  emit('message_stop', { type: 'message_stop' })
}

/**
 * Translate a stream of OpenAI chat chunks into Anthropic Messages SSE events.
 *
 * The translator is stateful because Anthropic wants explicit content blocks
 * (`content_block_start` / deltas / `content_block_stop`) while OpenAI streams
 * an undifferentiated delta object. Text becomes a text block; each tool call
 * index becomes a tool_use block and its argument fragments become
 * `input_json_delta` frames.
 */
export function createAnthropicStreamTranslator(options: {
  model: string
  resolveToolName?: ToolNameResolver
  emit: (event: string, data: any) => void
}): AnthropicStreamTranslator {
  const { emit } = options
  const resolve = options.resolveToolName
  const tools = new Map<number, ToolState>()
  let model = options.model
  let messageId = generatedId('msg')
  let started = false
  let finished = false
  let nextIndex = 0
  let textIndex: number | null = null
  let textOpen = false
  let stopReason: string | null = null
  let inputTokens: number | undefined
  let outputTokens: number | undefined

  function start(): void {
    if (started) return
    started = true
    emit('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens ?? 0,
          output_tokens: 0,
        },
      },
    })
  }

  function closeText(): void {
    if (!textOpen || textIndex === null) return
    textOpen = false
    emit('content_block_stop', { type: 'content_block_stop', index: textIndex })
  }

  function ensureText(): number {
    start()
    if (textOpen && textIndex !== null) return textIndex
    const index = nextIndex
    nextIndex += 1
    textIndex = index
    textOpen = true
    emit('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' },
    })
    return index
  }

  function startTool(state: ToolState): void {
    if (state.started || state.name === '') return
    state.started = true
    emit('content_block_start', {
      type: 'content_block_start',
      index: state.index,
      content_block: { type: 'tool_use', id: state.id, name: resolveName(resolve, state.name), input: {} },
    })
    if (state.buffered !== '') {
      emit('content_block_delta', {
        type: 'content_block_delta',
        index: state.index,
        delta: { type: 'input_json_delta', partial_json: state.buffered },
      })
      state.buffered = ''
    }
  }

  function ensureTool(key: number, incomingId: unknown, incomingName: unknown, args: unknown): ToolState {
    start()
    let state = tools.get(key)
    if (!state) {
      closeText()
      state = {
        index: nextIndex,
        id: typeof incomingId === 'string' && incomingId !== '' ? incomingId : generatedId('toolu'),
        name: '',
        started: false,
        buffered: '',
      }
      nextIndex += 1
      tools.set(key, state)
    } else if (typeof incomingId === 'string' && incomingId !== '') {
      state.id = incomingId
    }
    if (state.name === '' && typeof incomingName === 'string' && incomingName !== '') state.name = incomingName
    startTool(state)
    if (typeof args === 'string' && args !== '') {
      if (state.started) {
        emit('content_block_delta', {
          type: 'content_block_delta',
          index: state.index,
          delta: { type: 'input_json_delta', partial_json: args },
        })
      } else {
        state.buffered += args
      }
    }
    return state
  }

  function push(payload: unknown): void {
    if (finished) return
    let chunk: any = payload
    if (typeof payload === 'string') {
      if (payload.trim() === '[DONE]') {
        finish()
        return
      }
      try {
        chunk = JSON.parse(payload)
      } catch {
        return
      }
    }
    if (!chunk || typeof chunk !== 'object') return

    if (chunk.error) {
      fail(chunk.error)
      return
    }
    if (chunk.type === 'error') {
      fail(chunk.error ?? chunk)
      return
    }
    if (typeof chunk.id === 'string' && chunk.id !== '') messageId = chunk.id
    if (typeof chunk.model === 'string' && chunk.model !== '') model = chunk.model
    if (chunk.usage && typeof chunk.usage === 'object') {
      if (typeof chunk.usage.prompt_tokens === 'number') inputTokens = chunk.usage.prompt_tokens
      if (typeof chunk.usage.completion_tokens === 'number') outputTokens = chunk.usage.completion_tokens
    }

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined
    if (!choice) return

    // A gateway that answered a stream request with one complete JSON body.
    if (choice.message && !started) {
      emitComplete(chatToAnthropicMessage(chunk, model, resolve))
      return
    }

    const delta = choice.delta ?? {}
    const text = contentText(delta.content)
    if (text !== '') {
      const index = ensureText()
      emit('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text },
      })
    }

    if (delta.function_call && typeof delta.function_call === 'object') {
      ensureTool(-1, undefined, delta.function_call.name, delta.function_call.arguments)
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls) {
        const key = typeof call?.index === 'number' ? call.index : 0
        ensureTool(key, call?.id, call?.function?.name, call?.function?.arguments)
      }
    }

    if (choice.finish_reason) stopReason = mapStopReason(choice.finish_reason)
  }

  function emitComplete(message: any): void {
    if (finished) return
    finished = true
    emitAnthropicMessageAsEvents(message, emit)
  }

  function finish(): void {
    if (finished) return
    start()
    closeText()
    for (const state of tools.values()) {
      if (!state.started) {
        state.name = state.name || 'tool'
        startTool(state)
      }
      emit('content_block_stop', { type: 'content_block_stop', index: state.index })
    }
    finished = true
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
      usage: {
        ...(inputTokens !== undefined ? { input_tokens: inputTokens } : {}),
        output_tokens: outputTokens ?? 0,
      },
    })
    emit('message_stop', { type: 'message_stop' })
  }

  function fail(error: unknown): void {
    if (finished) return
    finished = true
    const message = typeof error === 'string'
      ? error
      : (error && typeof error === 'object' && typeof (error as any).message === 'string')
        ? (error as any).message
        : 'upstream stream failed'
    emit('error', {
      type: 'error',
      error: { type: 'api_error', message },
    })
  }

  return { push, finish, fail }
}
