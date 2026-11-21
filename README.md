# freiheit

English | [中文](README.zh-CN.md)

Set large models free: a CLI for free model endpoints, inspired by [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model).

An OpenAI / Anthropic compatible HTTP gateway that aggregates **free** model sources:

- **OpenCode Zen** free tier (`opencode.ai/inference/*`, `Bearer public`, with fingerprinting)
- **Kilo** free models (`ai-gateway.kilo.ai/api/v1`, `isFree: true`)

Only free tiers are included. Paid or restricted channels (EAC, ten-account, aggregate) are excluded.

## Usage

```bash
npx freiheit --help

# List available models
npx freiheit models

# Start the endpoint on the local network
npx freiheit serve --host 0.0.0.0
```

## Endpoints

- `GET /v1/models` (or `/models`) — aggregated list of free models
- `POST /v1/chat/completions` (or `/chat/completions`) — OpenAI chat
- `POST /v1/messages` (or `/messages`) — Anthropic messages (OpenCode models only)
- `GET /health`

## Bun dependency (OpenCode models)

OpenCode inference is routed through a Bun-based transport layer (the upstream `egressFetch` delegates POST requests to `opencode.ai` to `bun`). If `bun` is not on your PATH, requests for OpenCode models fail with a `laneConfig` error; the API response includes a hint and `laneConfig: true`. Kilo models and the `/v1/models` listing work fine without Bun.

Install Bun: https://bun.sh

## Notes

- Some OpenCode free model ids are region-sensitive (beam/crouton/pulse/muse-spark).
- Free quota is pooled per egress IP and rate-limited; heavy use may trigger `FreeUsageLimitError`.
