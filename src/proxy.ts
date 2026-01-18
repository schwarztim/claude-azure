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
  // If using router, pass through the original model name so router can select dynamically
  if (config.router) {
    return model;
  }

  // Otherwise, use the deployment name (tiered mode)
  return getDeployment(model, config);
}

// Convert Claude messages to OpenAI format (handles tool_use, tool_result, images)
function convertMessages(claudeMessages: any[], system?: any): any[] {
  const messages: any[] = [];

  // Add system message first
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
          textParts.push({ type: 'text', text: block.text || '' });
        } else if (blockType === 'image') {
          const source = block.source || {};
          if (source.type === 'base64') {
            const mediaType = source.media_type || 'image/png';
            const data = source.data || '';
            imageParts.push({
              type: 'image_url',
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
        const toolCalls = toolUseBlocks.map((tb) => ({
          id: tb.id || '',
          type: 'function',
          function: {
            name: tb.name || '',
            arguments: JSON.stringify(tb.input || {}),
          },
        }));

        const textContent = textParts.map((p) => p.text).join(' ') || null;
        messages.push({ role: 'assistant', content: textContent, tool_calls: toolCalls });
      }
      // User with tool_result blocks
      else if (toolResultBlocks.length > 0) {
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
      // Regular content (text and images)
      else if (textParts.length > 0 || imageParts.length > 0) {
        const combined = [...textParts, ...imageParts];
        if (combined.length === 1 && combined[0].type === 'text') {
          messages.push({ role, content: combined[0].text });
        } else {
          messages.push({ role, content: combined });
        }
      }
    }
  }

  return messages;
}

// Convert Claude tools to OpenAI function format
function convertTools(claudeTools: any[]): any[] {
  return claudeTools.map((tool) => {
    if (tool.type === 'function') return tool;
    return {
      type: 'function',
      function: {
        name: tool.name || '',
        description: tool.description || '',
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    };
  });
}

// Build OpenAI request from Claude request
function buildOpenAIRequest(claudeReq: any, config: AzureConfig): any {
  const req: any = {
    model: getModelName(claudeReq.model || '', config),
    messages: convertMessages(claudeReq.messages || [], claudeReq.system),
    stream: claudeReq.stream || false,
  };

  // Use max_completion_tokens (required for newer models like GPT-5.2)
  const maxTokens = claudeReq.max_tokens || 64000;
  req.max_completion_tokens = Math.max(4096, Math.min(maxTokens, 128000));

  if (claudeReq.temperature !== undefined) {
    req.temperature = claudeReq.temperature;
  }

  if (claudeReq.tools && claudeReq.tools.length > 0) {
    req.tools = convertTools(claudeReq.tools);
  }

  return req;
}

// Convert OpenAI response to Claude format
function convertResponse(openaiRes: any, model: string): any {
  const choice = openaiRes.choices?.[0] || {};
  const message = choice.message || {};
  const content: any[] = [];

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
      input_tokens: openaiRes.usage?.prompt_tokens || 0,
      output_tokens: openaiRes.usage?.completion_tokens || 0,
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
      const openaiReq = buildOpenAIRequest(claudeReq, azure);
      const originalModel = claudeReq.model || '';
      const deployment = getDeployment(originalModel, azure);

      if (verbose) {
        console.log(`[PROXY] ${originalModel} -> deployment:${deployment}, model:${openaiReq.model} (max_tokens=${openaiReq.max_completion_tokens})`);
      }

      const azureUrl = new URL(
        `/openai/deployments/${deployment}/chat/completions?api-version=${azure.apiVersion}`,
        azure.endpoint
      );

      const reqOptions: https.RequestOptions = {
        hostname: azureUrl.hostname,
        port: 443,
        path: azureUrl.pathname + azureUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': azure.apiKey,
        },
      };

      if (openaiReq.stream) {
        await handleStreaming(res, reqOptions, openaiReq, originalModel, verbose);
      } else {
        await handleNonStreaming(res, reqOptions, openaiReq, originalModel, verbose);
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

async function handleStreaming(
  res: http.ServerResponse,
  options: https.RequestOptions,
  openaiReq: any,
  model: string,
  verbose: boolean
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

async function handleNonStreaming(
  res: http.ServerResponse,
  options: https.RequestOptions,
  openaiReq: any,
  model: string,
  verbose: boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    const azureReq = https.request(options, (azureRes) => {
      let body = '';

      azureRes.on('data', (chunk) => { body += chunk; });

      azureRes.on('end', () => {
        try {
          if (azureRes.statusCode !== 200) {
            console.error(`[PROXY] Azure error ${azureRes.statusCode}: ${body}`);
            res.writeHead(azureRes.statusCode || 500, { 'Content-Type': 'application/json' });
            res.end(body);
            resolve();
            return;
          }

          const data = JSON.parse(body);
          const response = convertResponse(data, model);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
          resolve();
        } catch (error: any) {
          console.error('[PROXY] Parse error:', error.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: error.message } }));
          reject(error);
        }
      });
    });

    azureReq.on('error', (err) => {
      console.error('[PROXY] Request error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
      reject(err);
    });

    azureReq.write(JSON.stringify(openaiReq));
    azureReq.end();
  });
}

export function startProxy(config: ProxyConfig): Promise<void> {
  return new Promise((resolve) => {
    const server = createProxy(config);
    server.listen(config.port, '127.0.0.1', () => {
      resolve();
    });
  });
}
