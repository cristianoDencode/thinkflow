// Fake OpenAI-compatible provider for smoke tests. Port from argv[2].
import http from 'node:http';

const port = Number(process.argv[2] ?? 4900);
let calls = 0;

http
  .createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'mock-small' }] }));
      }
      calls++;
      const parsed = body ? JSON.parse(body) : {};
      const last = parsed.messages?.at(-1);
      const lastText = typeof last?.content === 'string' ? last.content : '';
      // unfenced flowchart with parentheses in a label: exercises the Mermaid normalizer
      // chat document mode: the user confirmed, so the mock asks for the generation (text fallback)
      const text = /diagrama/i.test(lastText)
        ? 'Segue:\nflowchart TD\nA[Início (x)] --> B[Fim]\n'
        : /CONFIRMO_GERAR/.test(lastText)
          ? 'Combinado, vou gerar.\n<gerar_documento>{"variaveis":{"assunto":"juros de mora","publico":"analistas"},"escopo":"somente o essencial"}</gerar_documento>'
          : `Resposta mock #${calls} (msgs=${parsed.messages?.length ?? 0}, tools=${parsed.tools?.length ?? 0}, último=${String(typeof last?.content === 'string' ? last.content : 'blocos').slice(0, 40)})`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = {
        id: `c${calls}`,
        object: 'chat.completion.chunk',
        created: 1,
        model: parsed.model,
      };
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      });
      for (const word of text.split(/(?<= )/))
        send({
          ...base,
          choices: [{ index: 0, delta: { content: word }, finish_reason: null }],
        });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      send({
        ...base,
        choices: [],
        usage: { prompt_tokens: 42, completion_tokens: 9, total_tokens: 51 },
      });
      res.end('data: [DONE]\n\n');
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`mock provider on ${port}`));
