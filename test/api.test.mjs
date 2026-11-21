// test/api.test.mjs — OpenAI-compatible API layer (api.js), no network needed:
// chat() and getModels() are injected as fakes, so duck.ai is never touched.
import path from 'node:path';
import assert from 'node:assert/strict';

const { startApiServer, resolveModel, makeModelCache } = await import('../api.js');
const { makeProxiedFetch, redactProxyUrl } = await import('../lib/proxyfetch.js');

// --- fakes --------------------------------------------------------------

const MODELS = [
  // list head is a "restricted flagship" — advertised by duck.ai but rejected
  // on chat. The default/alias resolution must NOT pick it; the chat layer
  // must fall back to the next family candidate when it errors.
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'openai', free: true, image: false, efforts: ['none', 'low', 'medium'] },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 mini', provider: 'openai', free: true, image: true, efforts: ['none', 'low', 'medium'] },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic', free: true, image: false, efforts: ['none', 'low'] },
  // advertises only "low": the API must not send the old hard-coded "none"
  { id: 'tinfoil/gpt-oss-120b', name: 'gpt-oss 120B', provider: 'tinfoil', free: true, image: false, efforts: ['low'] },
];

const chatCalls = [];
async function fakeChat(p) {
  chatCalls.push(JSON.parse(JSON.stringify({ ...p, onDelta: undefined, fetchFn: undefined, signal: undefined })));
  if (p.model === 'gpt-5.6-terra') {
    throw new Error('duck.ai chat HTTP 404: {"action":"error","status":404,"type":"ERR_MODEL_RESTRICTED"}');
  }
  if (p.image) {
    return { text: 'Here you go', image: { b64: Buffer.from('IMGDATA').toString('base64'), width: 8, height: 8, format: 'jpeg' } };
  }
  if (p.onDelta) { p.onDelta('Hello', 'Hello'); p.onDelta(' world', 'Hello world'); }
  return 'Hello world';
}

// --- resolveModel unit checks -------------------------------------------

assert.equal(resolveModel('claude-haiku-4-5', MODELS).id, 'claude-haiku-4-5');
assert.equal(resolveModel('CLAUDE-HAIKU-4-5', MODELS).id, 'claude-haiku-4-5'); // case-insensitive exact
assert.equal(resolveModel('', MODELS).id, 'gpt-5.4-mini'); // default = preferred, NOT the list head (terra)
// stale OpenAI ids from old clients must resolve to a current family member
assert.equal(resolveModel('gpt-4o-mini', MODELS).id, 'gpt-5.4-mini');
assert.equal(resolveModel('claude-3-haiku', MODELS).id, 'claude-haiku-4-5');
assert.equal(resolveModel('totally-unknown-model', MODELS), null);
// strict mode: exact upstream ids only, no aliasing of any kind
assert.equal(resolveModel('gpt-4o-mini', MODELS, true), null); // no family alias
assert.equal(resolveModel('haiku', MODELS, true), null); // no substring match
assert.equal(resolveModel('CLAUDE-HAIKU-4-5', MODELS, true).id, 'claude-haiku-4-5'); // exact, case-insensitive
assert.equal(resolveModel('', MODELS, true).id, 'gpt-5.4-mini'); // empty still means "default"
// with both preferred GPTs available, gpt-6-luna is the default / alias target
const PAIRED = [{ id: 'gpt-5.4-mini' }, { id: 'gpt-6-luna' }];
assert.equal(resolveModel('', PAIRED).id, 'gpt-6-luna');
assert.equal(resolveModel('gpt-4o-mini', PAIRED).id, 'gpt-6-luna');
assert.equal(resolveModel('', PAIRED, true).id, 'gpt-6-luna');
console.log('  ✓ resolveModel: exact / case-insensitive / preferred default / stale-id aliases / unknown / strict');

// --- static fallback: only live upstream ids, no invented models ----------

{
  const getModels = makeModelCache({ listModels: async () => { throw new Error('duck.ai unreachable'); } });
  const models = await getModels();
  assert.deepEqual(models.map((m) => m.id), [
    'gpt-6-luna', 'gpt-5.4-mini', 'claude-haiku-5-5',
    'mistral-small-2603', 'tinfoil/gpt-oss-120b', 'tinfoil/gemma4-31b',
  ]);
  // upstream advertises only "low" for gpt-oss-120b — defaultEffort must pick it
  assert.deepEqual(models.find((m) => m.id === 'tinfoil/gpt-oss-120b').efforts, ['low']);
  console.log('  ✓ static fallback: 6 live-aligned ids, no stale/invented models');
}

// --- free:false models are advertised upstream but unusable ---------------

{
  const upstream = [
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', provider: 'openai', free: false, efforts: ['none'] },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'anthropic', free: false, efforts: ['none'] },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna', provider: 'openai', free: true, efforts: ['none', 'low'] },
  ];
  const getModels = makeModelCache({ listModels: async () => upstream });
  const models = await getModels();
  assert.deepEqual(models.map((m) => m.id), ['gpt-6-luna']);
  assert.equal(resolveModel('gpt-5.6-terra', models, true), null); // not selectable in strict mode
  console.log('  ✓ free:false models filtered from the list and from strict-mode resolution');
}

// --- server instances ----------------------------------------------------

const key = 'test-key-123';
const authServer = await startApiServer({ port: 0, apiKey: key, chat: fakeChat, listModels: async () => MODELS });
const openServer = await startApiServer({ port: 0, chat: fakeChat, listModels: async () => MODELS });
const badServer = await startApiServer({
  port: 0,
  chat: async () => { throw new Error('duck.ai chat HTTP 400: {"action":"error","status":400,"type":"ERR_BAD_REQUEST"}'); },
  listModels: async () => MODELS,
});
const AUTH = 'http://127.0.0.1:' + authServer.address().port;
const OPEN = 'http://127.0.0.1:' + openServer.address().port;
const BAD = 'http://127.0.0.1:' + badServer.address().port;

// --- /health -------------------------------------------------------------

{
  const r = await fetch(OPEN + '/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.mode, 'api');
  assert.deepEqual(j.endpoints, ['/v1/models', '/v1/chat/completions']);
  console.log('  ✓ /health: ok, mode=api, endpoints listed');
}

// --- auth ----------------------------------------------------------------

{
  let r = await fetch(AUTH + '/v1/models');
  assert.equal(r.status, 401);
  r = await fetch(AUTH + '/v1/models', { headers: { authorization: 'Bearer wrong-key' } });
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.error.type, 'authentication_error');
  r = await fetch(AUTH + '/v1/models', { headers: { authorization: 'Bearer ' + key } });
  assert.equal(r.status, 200);
  console.log('  ✓ API_KEY: missing / wrong key → 401, correct key → 200');
}

// --- /v1/models shape -----------------------------------------------------

{
  const r = await fetch(OPEN + '/v1/models');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.object, 'list');
  assert.deepEqual(j.data.map((m) => m.id), ['gpt-5.6-terra', 'gpt-5.4-mini', 'claude-haiku-4-5', 'tinfoil/gpt-oss-120b']);
  assert.equal(j.data[0].object, 'model');
  assert.equal(j.data[0].owned_by, 'openai');
  assert.deepEqual(j.data[0].reasoning_efforts, ['none', 'low', 'medium']);
  console.log('  ✓ /v1/models: OpenAI list shape + effort/image metadata');
}

// --- non-stream chat completion -------------------------------------------

{
  chatCalls.length = 0;
  const r = await fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: 'You are a duck.' },
        { role: 'user', content: 'Hi' },
      ],
    }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.id.startsWith('chatcmpl-'));
  assert.equal(j.object, 'chat.completion');
  assert.equal(j.model, 'gpt-5.4-mini');
  assert.equal(j.choices[0].message.role, 'assistant');
  assert.equal(j.choices[0].message.content, 'Hello world');
  assert.equal(j.choices[0].finish_reason, 'stop');
  assert.ok(j.usage.total_tokens > 0);
  assert.equal(chatCalls.length, 1);
  assert.equal(chatCalls[0].effort, 'none'); // default
  // duck.ai rejects role:"system" with HTTP 400 ERR_BAD_REQUEST — the API must
  // fold it into the first user turn before calling the engine.
  assert.ok(chatCalls[0].messages.every((m) => m.role !== 'system'));
  assert.deepEqual(chatCalls[0].messages, [{ role: 'user', content: 'You are a duck.\n\nHi' }]);
  console.log('  ✓ non-stream chat.completion: content, usage, default effort, system folded');

  // developer is OpenAI's newer system role — same folding, same guarantee.
  chatCalls.length = 0;
  const rd = await fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4-mini',
      messages: [{ role: 'developer', content: 'Be terse.' }, { role: 'user', content: 'Hi' }],
    }),
  });
  assert.equal(rd.status, 200);
  assert.deepEqual(chatCalls[0].messages, [{ role: 'user', content: 'Be terse.\n\nHi' }]);
  console.log('  ✓ developer role folded into the first user turn');
}

// --- default reasoning effort must match the model ---------------------------

{
  chatCalls.length = 0;
  const r = await fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'tinfoil/gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 200);
  assert.equal(chatCalls[0].effort, 'low'); // "none" is rejected by duck.ai for this model
  console.log('  ✓ default effort: gpt-oss-120b (only "low" advertised) → "low", not "none"');
}

// --- streaming (SSE chunks + [DONE]) ---------------------------------------

{
  const r = await fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
      reasoning_effort: 'low',
    }),
  });
  assert.equal(r.status, 200);
  assert.ok((r.headers.get('content-type') || '').includes('text/event-stream'));
  const raw = await r.text();
  const lines = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  assert.equal(lines[lines.length - 1], '[DONE]');
  const chunks = lines.slice(0, -1).map((l) => JSON.parse(l));
  assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk'));
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant', content: '' });
  const text = chunks.slice(1, -1).map((c) => c.choices[0].delta.content).join('');
  assert.equal(text, 'Hello world');
  assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop');
  // the effort parameter reached the chat layer
  assert.equal(chatCalls[chatCalls.length - 1].effort, 'low');
  console.log('  ✓ stream: role chunk → content deltas → finish_reason stop → [DONE]');
}

// --- vision: OpenAI image_url part → duck.ai image part ---------------------

{
  chatCalls.length = 0;
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const r = await fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: png } }, { type: 'text', text: 'What is this?' }] }],
    }),
  });
  assert.equal(r.status, 200);
  const sent = chatCalls[0].messages[0].content;
  assert.equal(sent[0].type, 'image');
  assert.equal(sent[0].mimeType, 'image/png');
  assert.ok(sent[0].image.startsWith('data:image/png;base64,'));
  assert.deepEqual(sent[1], { type: 'text', text: 'What is this?' });
  console.log('  ✓ vision: image_url data:PNG → {type:"image", image, mimeType} + text part');
}

// --- image generation extension ----------------------------------------------

{
  chatCalls.length = 0;
  const r = await fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'draw a duck' }], image: true }),
  });
  const j = await r.json();
  assert.ok(Array.isArray(j.choices[0].message.images));
  assert.ok(j.choices[0].message.images[0].startsWith('data:image/jpeg;base64,'));
  assert.equal(chatCalls[0].image, true);
  console.log('  ✓ image:true extension → message.images data URL');
}

// --- validation errors ---------------------------------------------------------

{
  const post = (body) => fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  let r = await post('not json at all');
  assert.equal(r.status, 400);
  r = await post({});
  assert.equal(r.status, 400);
  r = await post({ messages: [] });
  assert.equal(r.status, 400);
  r = await post({ messages: [{ role: 'tool', content: 'x' }] });
  assert.equal(r.status, 400);
  r = await post({ messages: [{ role: 'system', content: '' }] });
  assert.equal(r.status, 400); // nothing left after folding
  r = await post({ messages: [{ role: 'user', content: 'hi' }], model: 'no-such-model' });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, 'model_not_found');
  r = await post({ messages: [{ role: 'user', content: 'hi' }], model: 'claude-haiku-4-5', reasoning_effort: 'medium' });
  assert.equal(r.status, 400); // claude fake supports only none/low
  r = await fetch(OPEN + '/nope');
  assert.equal(r.status, 404);
  console.log('  ✓ validation: bad json / empty messages / role / model 404 / bad effort / 404 route');
}

// --- unknown model alias resolution (stale id reaches the right model) ---------

{
  chatCalls.length = 0;
  const r = await fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.model, 'gpt-5.4-mini'); // resolved upstream id in the response
  console.log('  ✓ stale model id "gpt-4o-mini" → resolved to gpt-5.4-mini');
}

// --- restricted-flagship fallback (duck.ai advertises models it then rejects) ---

{
  chatCalls.length = 0;
  const r = await fetch(OPEN + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.model, 'gpt-5.4-mini'); // fell back inside the gpt family
  const tried = chatCalls.map((c) => c.model);
  assert.deepEqual(tried, ['gpt-5.6-terra', 'gpt-5.4-mini']);
  console.log('  ✓ ERR_MODEL_RESTRICTED → automatic fallback to the next family candidate');
}

// --- strict mode (STRICT_MODELS): upstream-aligned, no aliasing, no swap -------

{
  const strictServer = await startApiServer({ port: 0, strictModels: true, chat: fakeChat, listModels: async () => MODELS });
  const STRICT = 'http://127.0.0.1:' + strictServer.address().port;
  const spost = (body) => fetch(STRICT + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // stale/alias ids no longer resolve — 404 with the available list
  let r = await spost({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error.code, 'model_not_found');

  // exact upstream id is used as-is
  r = await spost({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).model, 'gpt-5.4-mini');

  // restricted model errors out — no silent swap to another family member
  chatCalls.length = 0;
  r = await spost({ model: 'gpt-5.6-terra', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error.message, /ERR_MODEL_RESTRICTED/);
  assert.deepEqual(chatCalls.map((c) => c.model), ['gpt-5.6-terra']); // exactly one attempt

  strictServer.close();
  console.log('  ✓ strict mode: alias → 404, exact id used as-is, restricted → 502 (no swap)');
}

// --- upstream 400 is a client error, not a gateway error ---------------------

{
  const r = await fetch(BAD + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 400); // NOT 502: clients must not retry a request that can never succeed
  const j = await r.json();
  assert.equal(j.error.type, 'invalid_request_error');
  console.log('  ✓ upstream 400 → 400 invalid_request_error (no retry storm)');
}

// --- multi-key auth + per-key rate limiting (upstream v1.2.0) ---------------

{
  const prevRpm = process.env.RATE_LIMIT_RPM;
  process.env.RATE_LIMIT_RPM = '1';
  let multi;
  try {
    multi = await startApiServer({ port: 0, apiKeys: 'key-a, key-b', chat: fakeChat, listModels: async () => MODELS });
    const M = 'http://127.0.0.1:' + multi.address().port;
    const get = (key) => fetch(M + '/health', key ? { headers: { authorization: 'Bearer ' + key } } : {});
    assert.equal((await get()).status, 401);
    assert.equal((await get('wrong')).status, 401);
    assert.equal((await get('key-a')).status, 200);
    const limited = await get('key-a');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal((await limited.json()).error.type, 'rate_limit_error');
    assert.equal((await get('key-b')).status, 200); // separate bucket
  } finally {
    if (prevRpm === undefined) delete process.env.RATE_LIMIT_RPM;
    else process.env.RATE_LIMIT_RPM = prevRpm;
    if (multi) multi.close();
  }
  console.log('  ✓ API_KEYS: multiple keys accepted, per-key RPM limit → 429 + Retry-After');
}

// --- PROXY_URL helper: fail-closed and credentials redacted -----------------

{
  assert.equal(redactProxyUrl('http://u:p@proxy:8080'), 'http://[REDACTED]@proxy:8080');
  await assert.rejects(() => makeProxiedFetch('ftp://proxy:21'), /unsupported proxy protocol/);
  console.log('  ✓ proxyfetch: bad PROXY_URL rejected, credentials redacted');
}

authServer.close();
openServer.close();
badServer.close();
console.log('api.test.mjs: all checks passed');
