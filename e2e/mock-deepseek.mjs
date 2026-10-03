// Mock DeepSeek chat-completions server for the Phase 4 end-to-end run.
// It is the ONLY mocked component of that run (embeddings, Postgres, Redis, the AI service and the
// backend are real). It records every request so the driver can assert which model was routed to.
//
//   POST /chat/completions           OpenAI/DeepSeek wire format, JSON or SSE (stream:true)
//   GET  /__log                       -> recorded requests;  POST /__log/reset
//   POST /__mode {"mode":"ok|429|500|timeout"}   inject provider failures
import http from 'node:http';

const PORT = Number(process.argv[2] || 55903);
let mode = 'ok';
const log = [];

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
});

/** Deterministic "model": answers from the first numbered passage and cites it. */
function answerFor(body) {
  const msgs = body.messages || [];
  const user = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';
  const jsonMode = body.response_format?.type === 'json_object';
  if (jsonMode) {
    if (/flashcards/i.test(user)) return JSON.stringify({ flashcards: [{ front: 'What absorbs red light?', back: 'Chlorophyll', source_ref: (/Source: ([^\n|]+)/.exec(user) || [])[1]?.trim() || 'x' }] });
    return JSON.stringify({ summary: 'A short summary.', key_takeaways: ['k1'] });
  }
  const first = /\[1\] Source: ([^\n]+)\n([\s\S]*?)(?:\n\n\[2\]|\n\n=== QUESTION)/.exec(user);
  if (!first) return 'Light reactions, Calvin cycle, Chlorophyll'; // topic/plan style prompts that carry no passages
  const sentence = first[2].split(/(?<=\.)\s/)[0].trim();
  return `${sentence} [1]`;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/__log') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(log)); }
  if (req.method === 'POST' && req.url === '/__log/reset') { log.length = 0; return res.end('ok'); }
  if (req.method === 'POST' && req.url === '/__mode') { mode = (await readBody(req)).mode || 'ok'; return res.end(mode); }
  if (req.method !== 'POST' || req.url !== '/chat/completions') { res.statusCode = 404; return res.end('{}'); }

  const body = await readBody(req);
  log.push({ model: body.model, thinking: body.thinking, stream: !!body.stream, json: body.response_format?.type === 'json_object',
             roles: (body.messages || []).map((m) => m.role), forged: JSON.stringify(body.messages || []).includes('FORGED'),
             auth: (req.headers.authorization || '').replace(/Bearer\s+(.{4}).*/, 'Bearer $1…'), mode });
  if (mode === '429') { res.statusCode = 429; res.setHeader('retry-after', '1'); res.setHeader('content-type', 'application/json'); return res.end('{"error":{"message":"rate limited"}}'); }
  if (mode === '500') { res.statusCode = 500; res.setHeader('content-type', 'application/json'); return res.end('{"error":{"message":"boom"}}'); }
  if (mode === 'timeout') return; // never answers

  const text = answerFor(body);
  const usage = { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 };
  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const words = text.split(/(?<=\s)/);
    for (const w of words) res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: w } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ model: body.model, choices: [], usage })}\n\n`);
    return res.end('data: [DONE]\n\n');
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'mock', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }));
});
server.listen(PORT, process.env.MOCK_HOST || '127.0.0.1', () => console.log(`mock deepseek on ${PORT}`));
