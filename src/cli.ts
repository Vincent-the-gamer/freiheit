#!/usr/bin/env node
import type { CAC } from 'cac'
import process from 'node:process'
import { cac } from 'cac'
import pkgJson from '../package.json'
import type { ModelEntry } from './server.js'
import { listAllModels, startServer, toPublicModels } from './server.js'

const { version } = pkgJson

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787

interface ServeOptions {
  host?: string
  port?: string | number
  silent?: boolean
}

interface ModelsOptions {
  json?: boolean
}

const cli: CAC = cac('freiheit')

function parsePort(raw: unknown): number | null {
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function serve(options: ServeOptions) {
  const port = parsePort(options.port ?? DEFAULT_PORT)
  if (port === null) {
    console.error(`Invalid port \`${options.port}\`: expected an integer between 1 and 65535.`)
    process.exitCode = 1
    return
  }

  startServer(port, String(options.host ?? DEFAULT_HOST), { silent: !!options.silent })
}

function printModels(models: ModelEntry[]) {
  const header = ['MODEL', 'SOURCE', 'CONTEXT']
  const rows = models.map((m) => [m.id, m.source, m.contextWindow ? String(m.contextWindow) : '-'])
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)))
  const format = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()

  console.log(format(header))
  console.log(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const row of rows) console.log(format(row))
  console.log(`\n${models.length} free model(s).`)
}

async function models(options: ModelsOptions) {
  try {
    const list = await listAllModels()
    if (options.json) console.log(JSON.stringify({ object: 'list', data: toPublicModels(list) }, null, 2))
    else printModels(list)
  } catch (error) {
    console.error(`Failed to list models: ${errorMessage(error)}`)
    process.exitCode = 1
  }
}

cli.usage('[options]\n       freiheit models [--json]')

cli.option('--host <host>, -H <host>', 'Host to bind.', { default: DEFAULT_HOST })
cli.option('--port, -p <port>', 'Port to listen on.', { default: DEFAULT_PORT })
cli.option('--silent', 'Suppress startup logs.')

cli
  .command('models', 'List the aggregated free models.')
  .option('--json', 'Print the OpenAI-style model list as JSON.')
  .action((options: ModelsOptions) => models(options))

cli.example('freiheit')
cli.example('freiheit --host 0.0.0.0 --port 8787')
cli.example('freiheit models')
cli.example('freiheit models --json')

cli.help()
cli.version(version)

let parsed: ReturnType<CAC['parse']>
try {
  parsed = cli.parse()
} catch (error) {
  console.error(errorMessage(error))
  process.exit(1)
}

// No sub-command matched: `freiheit`, `freiheit --port 3000`, etc. start the gateway.
// `models` is the only sub-command; there is no `serve` alias.
if (!cli.matchedCommand && !cli.options.help && !cli.options.version) {
  if (parsed.args.length > 0) {
    console.error(`Unknown command \`${parsed.args[0]}\`.`)
    cli.outputHelp()
    process.exit(1)
  }
  serve(cli.options as ServeOptions)
}
