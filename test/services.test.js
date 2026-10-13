import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { StrataClient, RequestGate, readSSE } from '../src/llm.js';
import { OpenAISpeech } from '../src/speech.js';
import { serviceConfig, requireServices } from '../src/services.js';

const delta = (content, extra = {}) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content, ...extra }, finish_reason: null }] })}\r\n\r\n`;
const end = 'data: [DONE]\r\n\r\n';
async function collect(source) { const parts = []; for await (const value of source) parts.push(value); return parts; }
function streamResponse(text) { return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } }); }
const messages = [{ role: 'system', content: '캐릭터' }, { role: 'user', content: '안녕' }];

test('configuration requires explicit local endpoint/model and independent cloud credentials', () => {
  const env = { OPENAI_API_KEY: 'cloud', STRATA_BASE_URL: 'http://127.0.0.1:8000/v1/', STRATA_MODEL: 'org/model' };
  assert.equal(requireServices(env).baseURL, 'http://127.0.0.1:8000/v1');
  assert.equal(requireServices(env).apiKey, '');
  assert.equal(requireServices(env).maxTokens, 128000);
  assert.equal(serviceConfig({ ...env, STRATA_MAX_TOKENS: '128000' }).maxTokens, 128000);
  assert.throws(() => serviceConfig({ ...env, STRATA_MAX_TOKENS: '128001' }), /128000/);
  for (const field of ['OPENAI_API_KEY', 'STRATA_BASE_URL', 'STRATA_MODEL']) assert.throws(() => requireServices({ ...env, [field]: '' }), new RegExp(field));
  for (const url of ['file:///tmp/model', 'http://user:pass@localhost/v1', 'http://localhost/v1?key=secret']) assert.throws(() => serviceConfig({ ...env, STRATA_BASE_URL: url }));
  assert.throws(() => serviceConfig({ STRATA_MAX_CONCURRENT: 'NaN' }));
  assert.throws(() => serviceConfig({ SPEECH_SESSION_MINUTES: '60' }));
  assert.throws(() => serviceConfig({ OPENAI_TRANSCRIBE_MODEL: 'gpt-live-transcribe' }), /server_vad/);
});

test('real HTTP chat probe and fragmented Korean SSE use only Strata credentials', async t => {
  const received = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); received.push({ url: req.url, auth: req.headers.authorization, data });
    if (!data.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    const bytes = Buffer.from(delta('안녕', { reasoning_content: 'DO NOT SPEAK' }) + delta('하세요.') + end);
    for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new StrataClient({ baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-only', model: 'org/model' });
  await client.check();
  assert.equal((await collect(client.stream(messages))).join(''), '안녕하세요.');
  assert.equal(received[0].data.max_tokens, 1);
  assert.deepEqual(received[1].data.messages, messages);
  assert.equal(received[1].data.model, 'org/model');
  assert.equal(received[1].data.stream, true);
  for (const request of received) { assert.equal(request.url, '/v1/chat/completions'); assert.equal(request.auth, 'Bearer local-only'); }
});

test('SSE parser handles individual UTF-8 bytes and split CRLF, comments and multiline data', async () => {
  const text = ': keepalive\r\n\r\ndata: {"text":\r\ndata: "한글"}\r\n\r\n';
  const body = new ReadableStream({ start(controller) { for (const byte of Buffer.from(text)) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.deepEqual(await collect(readSSE(body)), ['{"text":\n"한글"}']);
  await assert.rejects(collect(readSSE(new Response('data: {').body)), /중간/);
});

test('LLM rejects failed, empty, malformed and truncated streams without cloud fallback', async () => {
  for (const response of [new Response('private detail', { status: 503 }), streamResponse(end), streamResponse(delta('Partial')), streamResponse('data: invalid\n\n'), streamResponse(delta(null, { tool_calls: [{}] }))]) {
    let calls = 0;
    const client = new StrataClient({ baseURL: 'http://local/v1', model: 'model', fetchImpl: async (_url, options) => { calls++; assert.equal(options.headers.Authorization, undefined); return response; } });
    await assert.rejects(collect(client.stream(messages)), error => !error.message.includes('private detail'));
    assert.equal(calls, 1);
  }
});

test('concurrency gate removes an aborted waiter and releases slots fairly', async () => {
  const gate = new RequestGate(1); const first = await gate.acquire(new AbortController().signal);
  const controller = new AbortController();
  const waiting = gate.acquire(controller.signal); controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  let entered = false;
  const next = gate.acquire(new AbortController().signal).then(release => { entered = true; return release; });
  await Promise.resolve(); assert.equal(entered, false);
  first(); const release = await next; assert.equal(entered, true); release();
  assert.equal(gate.active, 0); assert.equal(gate.waiters.length, 0);
});

test('an aborted streaming request releases the local inference slot', async () => {
  const gate = new RequestGate(1); const controller = new AbortController();
  const client = new StrataClient({ baseURL: 'http://local/v1', model: 'model', gate,
    fetchImpl: async (_url, options) => new Response(new ReadableStream({ start(stream) {
      stream.enqueue(Buffer.from(delta('Hello.')));
      options.signal.addEventListener('abort', () => stream.error(options.signal.reason), { once: true });
    } }), { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  const stream = client.stream(messages, controller.signal);
  assert.equal((await stream.next()).value, 'Hello.');
  controller.abort(); await assert.rejects(stream.next(), { name: 'AbortError' });
  assert.equal(gate.active, 0);
});

test('TTS streams raw PCM from OpenAI with cloud credentials and the selected voice/speed', async () => {
  let request;
  const tts = new OpenAISpeech({ key: 'cloud-only', fetchImpl: async (url, options) => {
    request = { url, ...options }; return new Response(Buffer.alloc(960), { headers: { 'Content-Type': 'audio/pcm' } });
  } });
  const chunks = await collect(tts.synthesize('안녕하세요.', { voice: 'marin', speed: 1.2 }, new AbortController().signal));
  assert.equal(Buffer.concat(chunks).length, 960);
  assert.equal(request.url, 'https://api.openai.com/v1/audio/speech');
  assert.equal(request.headers.Authorization, 'Bearer cloud-only');
  assert.deepEqual(JSON.parse(request.body), { model: 'gpt-4o-mini-tts', input: '안녕하세요.', voice: 'marin', speed: 1.2, response_format: 'pcm', stream_format: 'audio' });
});

test('TTS rejects HTTP errors and incomplete PCM rather than playing error payloads', async () => {
  for (const response of [new Response('denied', { status: 401 }), new Response('{}', { headers: { 'Content-Type': 'application/json' } }), new Response(new Uint8Array([1]))]) {
    const tts = new OpenAISpeech({ key: 'cloud', fetchImpl: async () => response });
    await assert.rejects(collect(tts.synthesize('Hello', { voice: 'marin', speed: 1 }, new AbortController().signal)));
  }
});
