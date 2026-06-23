import type { ClientOptions } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { anthropicToOpenaiChat } from '../../server/proxy/transform/anthropicToOpenaiChat.js'
import { openaiChatToAnthropic } from '../../server/proxy/transform/openaiChatToAnthropic.js'
import { openaiChatStreamToAnthropic } from '../../server/proxy/streaming/openaiChatStreamToAnthropic.js'
import type { AnthropicRequest } from '../../server/proxy/transform/types.js'
import { logForDebugging } from '../../utils/debug.js'
import { getUserSpecifiedModelSetting } from '../../utils/model/model.js'
import { DEFAULT_GATEWAY_BASE_URL, normalizeGatewayUrl } from './fetch.js'
import { getUnieAITokens } from './storage.js'

export const UNIEAI_INFERENCE_DUMMY_KEY = 'unieai-studio-dummy-key'

export function shouldUseUnieAIInference(): boolean {
  const tokens = getUnieAITokens()
  return !!tokens?.gatewayApiKey
}

export function buildUnieAIInferenceFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
): ClientOptions['fetch'] {
  const inner = fetchOverride ?? globalThis.fetch

  return async (input, init) => {
    const url =
      input instanceof Request ? new URL(input.url) : new URL(String(input))

    if (!url.pathname.endsWith('/v1/messages')) {
      return inner(input, init)
    }

    const tokens = getUnieAITokens()
    if (!tokens?.gatewayApiKey) {
      throw new Error(
        'UnieAI Studio gateway credentials are missing. Run `unieai login` again.',
      )
    }

    const originalBody = await readAnthropicBody(input, init)

    // UnieAI Code: every request must run on a model the Studio gateway knows.
    // Auxiliary/subagent calls arrive on models that aren't in the user's Studio
    // catalog (e.g. the small/fast Haiku). Rather than silently picking one, fall
    // back to the model the user actually selected via /model. Only if that isn't
    // a known Studio model do we use the first available as a last resort.
    const available = tokens.availableModelIds ?? []
    if (!available.includes(originalBody.model)) {
      const selected = getUserSpecifiedModelSetting()
      if (typeof selected === 'string' && available.includes(selected)) {
        originalBody.model = selected
      } else if (available.length > 0) {
        originalBody.model = available[0]!
      }
    }

    // UNIEAI_GATEWAY_URL wins at request time so an operator can repoint an
    // already-logged-in session at the correct on-prem (地端) gateway without
    // forcing a re-login.
    const envGateway = process.env.UNIEAI_GATEWAY_URL?.trim()
    const baseURL = (
      envGateway
        ? normalizeGatewayUrl(envGateway)
        : tokens.gatewayBaseURL ?? DEFAULT_GATEWAY_BASE_URL
    ).replace(/\/$/, '')
    const transformedBody = anthropicToOpenaiChat(originalBody)

    const headers = new Headers()
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', transformedBody.stream ? 'text/event-stream' : 'application/json')
    headers.set('Authorization', `Bearer ${tokens.gatewayApiKey}`)

    logForDebugging(
      `[API REQUEST] ${url.pathname} routed_to=UnieAI/Studio model=${originalBody.model} source=${source ?? 'unknown'} request_id=${randomUUID()}`,
    )

    const upstream = await inner(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(transformedBody),
      signal: init?.signal,
    })

    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => '')
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'api_error',
            message: `UnieAI Studio gateway returned HTTP ${upstream.status}: ${errorText.slice(0, 500)}`,
          },
        },
        { status: upstream.status },
      )
    }

    if (transformedBody.stream) {
      if (!upstream.body) {
        return Response.json(
          {
            type: 'error',
            error: {
              type: 'api_error',
              message: 'UnieAI Studio gateway returned no body for stream',
            },
          },
          { status: 502 },
        )
      }
      return new Response(
        openaiChatStreamToAnthropic(upstream.body, originalBody.model),
        {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        },
      )
    }

    const responseBody = await upstream.json()
    return Response.json(openaiChatToAnthropic(responseBody, originalBody.model))
  }
}

async function readAnthropicBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<AnthropicRequest> {
  const directBody = init?.body
  if (typeof directBody === 'string') return JSON.parse(directBody) as AnthropicRequest
  if (directBody instanceof Uint8Array || directBody instanceof ArrayBuffer) {
    return JSON.parse(Buffer.from(directBody).toString('utf8')) as AnthropicRequest
  }
  if (input instanceof Request) return (await input.clone().json()) as AnthropicRequest
  throw new Error('Unable to read Anthropic request body for UnieAI Studio routing')
}
