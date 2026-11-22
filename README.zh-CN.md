<div align="center">
    <img src="static/banner.png" style="width: 1000px;"/>
    <h1>freiheit</h1>
    <p>实现大模型自由</p>
</div>

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]

[English](README.md) | 中文

免费模型端点 CLI，灵感来自 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)。

兼容 OpenAI / Anthropic 的 HTTP 网关，聚合**免费**模型来源：

- **OpenCode Zen** 免费通道（`opencode.ai/inference/*`，`Bearer public`，带指纹）
- **Kilo** 免费模型（`ai-gateway.kilo.ai/api/v1`，`isFree: true`）

仅包含免费通道。付费/受限通道（EAC、ten-account、aggregate）已经排除。

## 使用

```bash
npx freiheit --help

# 列出可用模型
npx freiheit models

# 以局域网启动端点
npx freiheit --host 0.0.0.0
```

## 端点

- `GET /v1/models`（或 `/models`）—— 聚合的免费模型列表
- `POST /v1/chat/completions`（或 `/chat/completions`）—— OpenAI 对话
- `POST /v1/messages`（或 `/messages`）—— Anthropic messages（仅 OpenCode 模型）
- `GET /health`

## Bun 依赖（OpenCode 模型）

OpenCode 推理通过基于 Bun 的传输层路由（上游 `egressFetch` 将 opencode.ai 的 POST 请求委托给 `bun`）。如果 PATH 中没有 `bun`，OpenCode 模型请求会因 `laneConfig` 错误而失败；API 响应中会包含提示和 `laneConfig: true`。Kilo 模型和 `/v1/models` 列表在没有 Bun 的情况下也能正常工作。

安装 Bun：https://bun.sh

## 说明

- 部分 OpenCode 免费模型的 id 存在地区敏感性（beam/crouton/pulse/muse-spark）。
- 免费额度是按出口 IP 池化并限制配额的；大量使用可能触发 `FreeUsageLimitError`。


<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/freiheit?style=flat&colorA=080f12&colorB=1fa669
[npm-version-href]: https://npmjs.com/package/freiheit
[npm-downloads-src]: https://img.shields.io/npm/dm/freiheit?style=flat&colorA=080f12&colorB=1fa669
[npm-downloads-href]: https://npmjs.com/package/freiheit