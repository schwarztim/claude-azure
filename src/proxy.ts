/**
 * Proxy server that translates Anthropic API to OpenAI/Azure format
 *
 * Ported from the battle-tested Python claude-universal proxy
 */
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { type AzureConfig } from './config.js';

interface ProxyConfig {
  port: number;
  azure: AzureConfig;
  verbose: boolean;
}

// Create SSE event string
function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isResponsesApiVersion(apiVersion: string): boolean {
  return apiVersion.startsWith('2025-04-01') || apiVersion.startsWith('2024-08-01');
}

function shouldUseResponsesAPI(config: AzureConfig): boolean {
  return !!config.router || isResponsesApiVersion(config.apiVersion);
}

function buildResponsesUrls(azure: AzureConfig, deployment: string): URL[] {
  const versions = [azure.apiVersion, '2025-04-01-preview'];
  const seen = new Set<string>();
  const urls: URL[] = [];

  for (const version of versions) {
    if (!version || seen.has(version)) continue;
    seen.add(version);
    // For router mode, try non-deployment endpoint first (APIM model router)
    if (azure.router) {
      urls.push(new URL(`/openai/responses?api-version=${version}`, azure.endpoint));
    }
    // Then try deployment-specific endpoint as fallback
    urls.push(new URL(`/openai/deployments/${deployment}/responses?api-version=${version}`, azure.endpoint));
  }

  return urls;
}

// Get deployment name for URL (Azure deployment endpoint)
function getDeployment(model: string, config: AzureConfig): string {
  // If router deployment is configured, use it for all models
  if (config.router) {
    return config.router;
  }

  // Otherwise, use tiered deployments
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return config.deployments.opus || 'gpt-4o';
  if (lower.includes('haiku')) return config.deployments.haiku || 'gpt-4o-mini';
  return config.deployments.sonnet || 'gpt-4o';
}

// Get model name for request body (what the router should select)
function getModelName(model: string, config: AzureConfig): string {
  // If using router, use the router deployment name
  // (APIM routers expect the deployment name, not Claude model names)
  if (config.router) {
    return config.router;
  }

  // Otherwise, use the deployment name (tiered mode)
  return getDeployment(model, config);
}

// Detect if request contains tool usage (tool_use or tool_result blocks)
function hasToolUsage(messages: any[]): boolean {
  for (const msg of messages) {
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const blockType = block.type || '';
        if (blockType === 'tool_use' || blockType === 'tool_result') {
          return true;
        }
      }
    }
  }
  return false;
}

// Convert Claude messages to OpenAI format (handles tool_use, tool_result, images)
function convertMessages(claudeMessages: any[], system?: any, useResponsesAPI: boolean = false): any[] {
  const messages: any[] = [];

  // Add system message first (both endpoints support this)
  if (system) {
    if (typeof system === 'string') {
      messages.push({ role: 'system', content: system });
    } else if (Array.isArray(system)) {
      const text = (system as any[])
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text || '')
        .join(' ');
      messages.push({ role: 'system', content: text });
    }
  }

  for (const msg of claudeMessages) {
    const role = msg.role || 'user';
    const content = msg.content;

    // Simple string content
    if (typeof content === 'string') {
      messages.push({ role, content });
      continue;
    }

    // List content (multimodal, tool_use, tool_result)
    if (Array.isArray(content)) {
      const textParts: any[] = [];
      const imageParts: any[] = [];
      const toolUseBlocks: any[] = [];
      const toolResultBlocks: any[] = [];

      for (const block of content) {
        const blockType = block.type || '';

        if (blockType === 'text') {
          // Responses API uses different content types than Chat Completions
          const textType = useResponsesAPI
            ? (role === 'assistant' ? 'output_text' : 'input_text')
            : 'text';
          textParts.push({ type: textType, text: block.text || '' });
        } else if (blockType === 'image') {
          const source = block.source || {};
          if (source.type === 'base64') {
            const mediaType = source.media_type || 'image/png';
            const data = source.data || '';
            // Responses API uses 'input_image' type
            const imageType = useResponsesAPI ? 'input_image' : 'image_url';
            imageParts.push({
              type: imageType,
              image_url: { url: `data:${mediaType};base64,${data}` },
            });
          }
        } else if (blockType === 'tool_use') {
          toolUseBlocks.push(block);
        } else if (blockType === 'tool_result') {
          toolResultBlocks.push(block);
        }
      }

      // Assistant with tool_use blocks
      if (role === 'assistant' && toolUseBlocks.length > 0) {
        // Responses API doesn't support tool_calls - convert to text format
        if (useResponsesAPI) {
          const toolText = toolUseBlocks
            .map((tb) => `[Tool: ${tb.name}, Input: ${JSON.stringify(tb.input)}]`)
            .join(' ');
          const textContent = textParts.map((p) => p.text).join(' ').trim();
          const combinedContent = [textContent, toolText].filter(Boolean).join(' ') || '';
          messages.push({ role: 'assistant', content: combinedContent });
        } else {
          // Chat Completions API supports tool_calls
          const toolCalls = toolUseBlocks.map((tb) => ({
            id: tb.id || '',
            type: 'function',
            function: {
              name: tb.name || '',
              arguments: JSON.stringify(tb.input || {}),
            },
          }));
          const textContent = textParts.map((p) => p.text).join(' ').trim();
          messages.push({ role: 'assistant', content: textContent || null, tool_calls: toolCalls });
        }
      }
      // User with tool_result blocks
      else if (toolResultBlocks.length > 0) {
        // Responses API doesn't support 'tool' role - convert to user message
        if (useResponsesAPI) {
          const toolResults = toolResultBlocks.map((result) => {
            let resultContent = result.content || '';
            if (Array.isArray(resultContent)) {
              resultContent = resultContent
                .map((item: any) => (typeof item === 'string' ? item : item.text || ''))
                .join('\n');
            } else if (typeof resultContent !== 'string') {
              resultContent = JSON.stringify(resultContent);
            }
            const isError = result.is_error || false;
            return `[Tool Result: ${isError ? 'Error: ' : ''}${resultContent}]`;
          }).join(' ');

          const textContent = textParts.map((p) => p.text).join(' ').trim();
          const combinedContent = [textContent, toolResults].filter(Boolean).join(' ') || '';
          messages.push({ role: 'user', content: combinedContent });
        } else {
          // Chat Completions API supports 'tool' role
          for (const result of toolResultBlocks) {
            let resultContent = result.content || '';
            if (Array.isArray(resultContent)) {
              resultContent = resultContent
                .map((item: any) => (typeof item === 'string' ? item : item.text || ''))
                .join('\n');
            } else if (typeof resultContent !== 'string') {
              resultContent = JSON.stringify(resultContent);
            }

            const isError = result.is_error || false;
            messages.push({
              role: 'tool',
              tool_call_id: result.tool_use_id || '',
              content: isError ? `Error: ${resultContent}` : resultContent,
            });
          }

          // Also include any text content
          if (textParts.length > 0) {
            const combinedText = textParts.map((p) => p.text).join(' ').trim();
            if (combinedText) {
              messages.push({ role: 'user', content: combinedText });
            }
          }
        }
      }
      // Regular content (text and images)
      else if (textParts.length > 0 || imageParts.length > 0) {
        const combined = [...textParts, ...imageParts];
        if (combined.length === 1 && combined[0].type === 'text') {
          // Ensure we don't send null content - use empty string as fallback
          messages.push({ role, content: combined[0].text || '' });
        } else {
          messages.push({ role, content: combined });
        }
      }
    }
  }

  return messages;
}

// Convert Claude tools to OpenAI/Azure function format
function convertTools(claudeTools: any[], useResponsesAPI: boolean = false): any[] {
  return claudeTools.map((tool) => {
    // If already in OpenAI format, return as-is for Chat Completions
    if (tool.type === 'function' && !useResponsesAPI) return tool;

    if (useResponsesAPI) {
      // Responses API uses a flatter structure with name/description/parameters at root
      return {
        type: 'function',
        name: tool.name || tool.function?.name || '',
        description: tool.description || tool.function?.description || '',
        parameters: tool.input_schema || tool.function?.parameters || { type: 'object', properties: {} },
      };
    } else {
      // Chat Completions API nests name/description/parameters inside function
      return {
        type: 'function',
        function: {
          name: tool.name || '',
          description: tool.description || '',
          parameters: tool.input_schema || { type: 'object', properties: {} },
        },
      };
    }
  });
}

// Build OpenAI request from Claude request
function buildOpenAIRequest(claudeReq: any, config: AzureConfig, useResponsesAPI: boolean = false): any {
  const maxTokens = claudeReq.max_tokens || 64000;
  let messages = convertMessages(claudeReq.messages || [], claudeReq.system, useResponsesAPI);

  // For Responses API, ensure no null content (must be string or array, use empty string as fallback)
  if (useResponsesAPI) {
    messages = messages.map((msg: any) => {
      if (msg.content === null || msg.content === undefined) {
        return { ...msg, content: '' };
      }
      return msg;
    });
  }

  const req: any = {
    model: getModelName(claudeReq.model || '', config),
    stream: claudeReq.stream || false,
  };

  if (useResponsesAPI) {
    // Responses API uses 'input' and 'max_output_tokens'
    req.input = messages;
    req.max_output_tokens = Math.max(4096, Math.min(maxTokens, 128000));
  } else {
    // Chat Completions API uses 'messages' and 'max_completion_tokens'
    req.messages = messages;
    req.max_completion_tokens = Math.max(4096, Math.min(maxTokens, 128000));
  }

  if (claudeReq.temperature !== undefined) {
    req.temperature = claudeReq.temperature;
  }

  if (claudeReq.tools && claudeReq.tools.length > 0) {
    // Azure /responses endpoint expects tools with name at root (Responses API format)
    // but other fields use Chat Completions format
    req.tools = convertTools(claudeReq.tools, useResponsesAPI);
  }

  const reasoningEffort = config.reasoningEffort;
  if (reasoningEffort) {
    const modelName = String(req.model || '').toLowerCase();
    const targetModel = config.reasoningModel?.toLowerCase();
    const shouldApplyReasoning =
      (targetModel && (modelName === targetModel || !!config.router)) ||
      (!targetModel && modelName.includes('gpt-5'));
    if (shouldApplyReasoning) {
      if (useResponsesAPI) {
        req.reasoning = { effort: reasoningEffort };
      } else {
        req.reasoning_effort = reasoningEffort;
      }
    }
  }

  return req;
}

// Convert OpenAI/Azure response to Claude format
function convertResponse(openaiRes: any, model: string, _useResponsesAPI: boolean = false): any {
  const content: any[] = [];

  if (openaiRes.choices?.length) {
    const choice = openaiRes.choices?.[0] || {};
    const message = choice.message || {};

    if (message.content) {
      content.push({ type: 'text', text: message.content });
    }

    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        let input = {};
        try {
          input = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          input = {};
        }
        content.push({
          type: 'tool_use',
          id: tc.id || '',
          name: tc.function?.name || '',
          input,
        });
      }
    }

    const finishReason = choice.finish_reason || 'stop';
    const stopReasonMap: Record<string, string> = {
      stop: 'end_turn',
      length: 'max_tokens',
      tool_calls: 'tool_use',
      content_filter: 'end_turn',
    };

    return {
      id: openaiRes.id || `msg_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content,
      model,
      stop_reason: stopReasonMap[finishReason] || 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: openaiRes.usage?.prompt_tokens || openaiRes.usage?.input_tokens || 0,
        output_tokens: openaiRes.usage?.completion_tokens || openaiRes.usage?.output_tokens || 0,
      },
    };
  }

  const textParts: string[] = [];
  const toolUses: any[] = [];

  const pushToolUse = (id: string, name: string, args: any) => {
    let input = {};
    if (typeof args === 'string') {
      try {
        input = JSON.parse(args);
      } catch {
        input = {};
      }
    } else if (args && typeof args === 'object') {
      input = args;
    }
    toolUses.push({ type: 'tool_use', id: id || '', name: name || '', input });
  };

  const extractToolCall = (item: any) => {
    if (!item) return null;
    if (item.type === 'tool_call' || item.type === 'function_call') {
      return {
        id: item.id || '',
        name: item.name || item.tool_name || item.function?.name || '',
        args: item.arguments || item.tool_arguments || item.function?.arguments || '{}',
      };
    }
    if (item.type === 'tool' && item.name) {
      return {
        id: item.id || '',
        name: item.name || '',
        args: item.arguments || item.input || '{}',
      };
    }
    return null;
  };

  if (typeof openaiRes.output_text === 'string') {
    textParts.push(openaiRes.output_text);
  }

  if (Array.isArray(openaiRes.output)) {
    for (const item of openaiRes.output) {
      if (item?.type === 'message') {
        const itemContent = item.content;
        if (typeof itemContent === 'string') {
          textParts.push(itemContent);
        } else if (Array.isArray(itemContent)) {
          for (const block of itemContent) {
            if (block?.type === 'output_text' || block?.type === 'text') {
              textParts.push(block.text || '');
            }
            const toolCall = extractToolCall(block);
            if (toolCall) {
              pushToolUse(toolCall.id, toolCall.name, toolCall.args);
            }
          }
        }
      } else {
        const toolCall = extractToolCall(item);
        if (toolCall) {
          pushToolUse(toolCall.id, toolCall.name, toolCall.args);
        }
      }
    }
  }

  if (textParts.length > 0) {
    content.push({ type: 'text', text: textParts.join('') });
  }
  if (toolUses.length > 0) {
    content.push(...toolUses);
  }

  const usage = openaiRes.usage || {};
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;

  return {
    id: openaiRes.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

export function createProxy(config: ProxyConfig): http.Server {
  const { port, azure, verbose } = config;

  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', provider: 'azure' }));
      return;
    }

    // Auth/telemetry endpoints - return success
    if (req.url?.includes('auth') || req.url?.includes('token') ||
        req.url?.includes('telemetry') || req.url?.includes('event_logging')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // Only handle POST to /v1/messages
    if (req.method !== 'POST' || !req.url?.includes('/messages')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Not found: ${req.url}` }));
      return;
    }

    // Read body
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }

    try {
      const claudeReq = JSON.parse(body);
      const originalModel = claudeReq.model || '';
      const deployment = getDeployment(originalModel, azure);
      const wantsStream = !!claudeReq.stream;

      // Determine if we should use Responses API (when router is configured)
      // BUT: Don't use Responses API if request contains tool usage (tool_use/tool_result)
      // because Responses API doesn't handle tools well (causes 429 internal errors)
      const hasTools = hasToolUsage(claudeReq.messages || []);
      const useResponsesAPI = shouldUseResponsesAPI(azure) && !hasTools;

      if (verbose && hasTools && shouldUseResponsesAPI(azure)) {
        console.log('[PROXY] Tool usage detected - forcing Chat Completions API instead of Responses API');
      }

      const openaiReq = buildOpenAIRequest(claudeReq, azure, useResponsesAPI);
      if (useResponsesAPI) {
        openaiReq.stream = false;
      }

      if (verbose) {
        const apiEndpoint = useResponsesAPI ? 'responses' : `deployments/${deployment}/chat/completions`;
        const maxTokens =
          openaiReq.max_completion_tokens ?? openaiReq.max_output_tokens ?? openaiReq.max_tokens ?? 'unknown';
        console.log(`[PROXY] ${originalModel} -> ${deployment} @ ${azure.endpoint}/openai/${apiEndpoint}?api-version=${azure.apiVersion} (max_tokens=${maxTokens})`);
        console.log(`[PROXY] Sending ${useResponsesAPI ? '/responses endpoint' : 'Chat Completions'} request to Azure...`);

        // Show full messages if tool-like content detected
        const messages = openaiReq.input || openaiReq.messages || [];
        const hasToolContent = messages.some((msg: any) =>
          typeof msg.content === 'string' && (msg.content.includes('[Tool:') || msg.content.includes('[Tool Result:'))
        );

        if (hasToolContent) {
          console.log(`[PROXY] Tool usage detected - full payload:`);
          console.log(JSON.stringify(openaiReq, null, 2));
        } else {
          console.log(`[PROXY] Request payload: ${JSON.stringify(openaiReq).substring(0, 200)}...`);
        }
      }

      const azureUrls = useResponsesAPI
        ? buildResponsesUrls(azure, deployment)
        : [
            new URL(
              `/openai/deployments/${deployment}/chat/completions?api-version=${azure.apiVersion}`,
              azure.endpoint
            ),
          ];

      // Don't add Chat Completions fallback for router mode
      // (router deployments like gpt-5.2-codex only work with Responses API)
      if (useResponsesAPI && !azure.router) {
        // For non-router mode, add Chat Completions as fallback
        azureUrls.push(
          new URL(
            `/openai/deployments/${deployment}/chat/completions?api-version=${azure.apiVersion}`,
            azure.endpoint
          )
        );
      }

      const reqOptionsList: https.RequestOptions[] = azureUrls.map((azureUrl) => ({
        hostname: azureUrl.hostname,
        port: 443,
        path: azureUrl.pathname + azureUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': azure.apiKey,
        },
      }));

      if (wantsStream) {
        if (useResponsesAPI) {
          await handleStreamingFromNonStreaming(res, reqOptionsList, openaiReq, originalModel, verbose, useResponsesAPI);
        } else {
          await handleStreaming(res, reqOptionsList[0], openaiReq, originalModel, verbose, useResponsesAPI);
        }
      } else {
        await handleNonStreaming(res, reqOptionsList, openaiReq, originalModel, verbose, useResponsesAPI);
      }
    } catch (error: any) {
      console.error('[PROXY] Error:', error.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: { message: error.message } }));
      }
    }
  });

  return server;
}

function formatRequestTarget(options: https.RequestOptions): string {
  const host = options.hostname || 'unknown-host';
  const path = options.path || '';
  return `https://${host}${path}`;
}

function requestJson(options: https.RequestOptions, payload: any): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const azureReq = https.request(options, (azureRes) => {
      let body = '';
      azureRes.on('data', (chunk) => { body += chunk; });
      azureRes.on('end', () => {
        resolve({ statusCode: azureRes.statusCode || 0, body });
      });
    });

    azureReq.on('error', (err) => {
      reject(err);
    });

    azureReq.write(JSON.stringify(payload));
    azureReq.end();
  });
}

async function requestWithFallback(
  optionsList: https.RequestOptions[],
  payload: any,
  verbose: boolean
): Promise<{ statusCode: number; body: string; options: https.RequestOptions }> {
  let lastError: Error | null = null;

  for (let i = 0; i < optionsList.length; i++) {
    const options = optionsList[i];

    // Adapt payload based on endpoint type
    let currentPayload = payload;
    if (options.path?.includes('/chat/completions') && payload.input) {
      // Convert Responses API format to Chat Completions format
      currentPayload = { ...payload };
      currentPayload.messages = payload.input;
      delete currentPayload.input;
      if (payload.max_output_tokens) {
        currentPayload.max_completion_tokens = payload.max_output_tokens;
        delete currentPayload.max_output_tokens;
      }
    }

    if (verbose) {
      console.log(`[PROXY] Trying endpoint ${i + 1}/${optionsList.length}: ${formatRequestTarget(options)}`);
    }

    try {
      const result = await requestJson(options, currentPayload);
      // Only retry on 404 (endpoint not found), not 400 (bad request)
      if (result.statusCode === 404 && i < optionsList.length - 1) {
        if (verbose) {
          console.log(`[PROXY] Azure 404 from ${formatRequestTarget(options)}; retrying...`);
        }
        continue;
      }
      // Log error responses with full detail for debugging
      if (result.statusCode !== 200 && verbose) {
        console.log(`[PROXY] Azure error ${result.statusCode} from ${formatRequestTarget(options)}`);
        // For 400/429 errors, log full body to understand what Azure is rejecting
        if (result.statusCode === 400 || result.statusCode === 429) {
          try {
            const errorBody = JSON.parse(result.body);
            console.log(`[PROXY] Error detail:`, JSON.stringify(errorBody, null, 2));
          } catch {
            console.log(`[PROXY] Error detail: ${result.body}`);
          }
        } else {
          console.log(`[PROXY] Error detail: ${result.body.substring(0, 200)}`);
        }
      }
      if (verbose && result.statusCode === 200) {
        console.log(`[PROXY] Success with endpoint: ${formatRequestTarget(options)}`);
      }
      return { ...result, options };
    } catch (err: any) {
      lastError = err;
      if (i < optionsList.length - 1) {
        if (verbose) {
          console.log(`[PROXY] Azure request error from ${formatRequestTarget(options)}: ${err.message}; retrying...`);
        }
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error('Azure request failed');
}

async function handleStreaming(
  res: http.ServerResponse,
  options: https.RequestOptions,
  openaiReq: any,
  model: string,
  verbose: boolean,
  useResponsesAPI: boolean = false
): Promise<void> {
  return new Promise((resolve, reject) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const msgId = `msg_${Date.now()}`;
    let outputTokens = 0;
    let finishReason = 'end_turn';

    // Send message_start
    res.write(sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }));

    const azureReq = https.request(options, (azureRes) => {
      // Check for error status
      if (azureRes.statusCode !== 200) {
        let errorBody = '';
        azureRes.on('data', (chunk) => { errorBody += chunk; });
        azureRes.on('end', () => {
          console.error(`[PROXY] Azure error ${azureRes.statusCode}: ${errorBody}`);
          // Send error as text block
          res.write(sseEvent('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }));
          res.write(sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: `Error from Azure: ${errorBody}` },
          }));
          res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
          res.write(sseEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 0 },
          }));
          res.write(sseEvent('message_stop', { type: 'message_stop' }));
          res.end();
          resolve();
        });
        return;
      }

      let buffer = '';
      let textBlockStarted = false;
      let currentBlockIndex = 0;
      const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
      const toolBlocksStarted = new Set<number>();

      azureRes.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') continue;

          try {
            const data = JSON.parse(dataStr);
            const choices = data.choices || [];
            if (!choices.length) continue;

            const choice = choices[0];
            const delta = choice.delta || {};

            // Handle finish reason
            if (choice.finish_reason) {
              if (choice.finish_reason === 'tool_calls') finishReason = 'tool_use';
              else if (choice.finish_reason === 'length') finishReason = 'max_tokens';
              else finishReason = 'end_turn';
            }

            // Handle text content
            if (delta.content) {
              if (!textBlockStarted) {
                res.write(sseEvent('content_block_start', {
                  type: 'content_block_start',
                  index: currentBlockIndex,
                  content_block: { type: 'text', text: '' },
                }));
                textBlockStarted = true;
              }
              res.write(sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index: currentBlockIndex,
                delta: { type: 'text_delta', text: delta.content },
              }));
            }

            // Handle tool calls
            if (delta.tool_calls) {
              if (verbose) console.log(`[PROXY] Tool call delta: ${JSON.stringify(delta.tool_calls)}`);

              // Close text block if open
              if (textBlockStarted && !toolBlocksStarted.size) {
                res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex }));
                currentBlockIndex++;
                textBlockStarted = false;
              }

              for (const tc of delta.tool_calls) {
                const tcIndex = tc.index || 0;
                const blockIndex = currentBlockIndex + tcIndex;

                if (!toolCalls.has(tcIndex)) {
                  toolCalls.set(tcIndex, { id: tc.id || '', name: '', arguments: '' });
                }

                const toolCall = toolCalls.get(tcIndex)!;
                if (tc.id) toolCall.id = tc.id;
                if (tc.function?.name) toolCall.name = tc.function.name;
                if (tc.function?.arguments) toolCall.arguments += tc.function.arguments;

                // Start tool block
                if (!toolBlocksStarted.has(blockIndex) && toolCall.name) {
                  res.write(sseEvent('content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: {
                      type: 'tool_use',
                      id: toolCall.id,
                      name: toolCall.name,
                      input: {},
                    },
                  }));
                  toolBlocksStarted.add(blockIndex);
                }

                // Send argument delta
                if (tc.function?.arguments && toolBlocksStarted.has(blockIndex)) {
                  res.write(sseEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
                  }));
                }
              }
            }

            // Handle usage
            if (data.usage) {
              outputTokens = data.usage.completion_tokens || outputTokens;
            }
          } catch {
            // Skip unparseable chunks
          }
        }
      });

      azureRes.on('end', () => {
        // Close text block
        if (textBlockStarted && !toolBlocksStarted.has(currentBlockIndex)) {
          res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: currentBlockIndex }));
        }

        // Close tool blocks
        for (const idx of toolBlocksStarted) {
          res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: idx }));
        }

        // If nothing was started, send empty text block
        if (!textBlockStarted && !toolBlocksStarted.size) {
          res.write(sseEvent('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }));
          res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
        }

        // Send message_delta and message_stop
        res.write(sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: finishReason, stop_sequence: null },
          usage: { output_tokens: outputTokens },
        }));
        res.write(sseEvent('message_stop', { type: 'message_stop' }));
        res.end();
        resolve();
      });

      azureRes.on('error', (err) => {
        console.error('[PROXY] Azure stream error:', err);
        res.end();
        reject(err);
      });
    });

    azureReq.on('error', (err) => {
      console.error('[PROXY] Request error:', err);
      res.end();
      reject(err);
    });

    azureReq.write(JSON.stringify(openaiReq));
    azureReq.end();
  });
}

async function handleStreamingFromNonStreaming(
  res: http.ServerResponse,
  optionsList: https.RequestOptions[],
  openaiReq: any,
  model: string,
  verbose: boolean,
  useResponsesAPI: boolean = false
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const msgId = `msg_${Date.now()}`;
  res.write(sseEvent('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  }));

  const writeError = (message: string) => {
    res.write(sseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }));
    res.write(sseEvent('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: message },
    }));
    res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    res.write(sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 0 },
    }));
    res.write(sseEvent('message_stop', { type: 'message_stop' }));
    res.end();
  };

  try {
    const { statusCode, body } = await requestWithFallback(optionsList, openaiReq, verbose);
    if (statusCode !== 200) {
      console.error(`[PROXY] Error response: ${statusCode}`);
      console.error(`[PROXY] Error detail: ${body}`);
      writeError(`Error from Azure: ${body}`);
      return;
    }

    const data = JSON.parse(body);
    const response = convertResponse(data, model, useResponsesAPI);
    const responseContent = response.content || [];

    if (responseContent.length === 0) {
      res.write(sseEvent('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }));
      res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }));
    } else {
      let index = 0;
      for (const block of responseContent) {
        if (block.type === 'text') {
          res.write(sseEvent('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'text', text: '' },
          }));
          res.write(sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: block.text || '' },
          }));
          res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
          index += 1;
        } else if (block.type === 'tool_use') {
          res.write(sseEvent('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: {
              type: 'tool_use',
              id: block.id || '',
              name: block.name || '',
              input: {},
            },
          }));
          const payload = JSON.stringify(block.input || {});
          res.write(sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: payload },
          }));
          res.write(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
          index += 1;
        }
      }
    }

    res.write(sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: response.stop_reason || 'end_turn', stop_sequence: null },
      usage: { output_tokens: response.usage?.output_tokens || 0 },
    }));
    res.write(sseEvent('message_stop', { type: 'message_stop' }));
    res.end();
  } catch (error: any) {
    console.error('[PROXY] Request error:', error.message);
    writeError(`Error from Azure: ${error.message}`);
  }
}

async function handleNonStreaming(
  res: http.ServerResponse,
  optionsList: https.RequestOptions[] | https.RequestOptions,
  openaiReq: any,
  model: string,
  verbose: boolean,
  useResponsesAPI: boolean = false
): Promise<void> {
  const optionsArray = Array.isArray(optionsList) ? optionsList : [optionsList];

  try {
    const { statusCode, body } = await requestWithFallback(optionsArray, openaiReq, verbose);
    if (statusCode !== 200) {
      console.error(`[PROXY] Error response: ${statusCode}`);
      console.error(`[PROXY] Error detail: ${body}`);
      res.writeHead(statusCode || 500, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    const data = JSON.parse(body);
    if (verbose) {
      console.log(`[PROXY] Response status: ${statusCode}`);
      console.log(`[PROXY] Response preview: ${body.substring(0, 200)}...`);
    }
    const response = convertResponse(data, model, useResponsesAPI);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  } catch (error: any) {
    console.error('[PROXY] Request error:', error.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  }
}

export function startProxy(config: ProxyConfig): Promise<void> {
  return new Promise((resolve) => {
    const server = createProxy(config);
    server.listen(config.port, '127.0.0.1', () => {
      resolve();
    });
  });
}
