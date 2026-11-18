import { deflateSync } from 'node:zlib';
import { ctLayoutSchema, type CtLayout } from '@thinkflow/shared';
import {
  createCtDocument,
  type CtDocument,
} from '../../../src/contexts/testing/domain/ct-document';

/* Invented data only: no real municipal content belongs in fixtures. */

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export type Rgb = [number, number, number];

/** Solid PNG with a title bar and a few "form" rows, enough to eyeball scaling in a render. */
export function makePng(width: number, height: number, accent: Rgb = [70, 110, 160]): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      let px: Rgb = [226, 224, 224];
      if (y < height * 0.06) px = accent;
      else if (y > height * 0.25 && y < height * 0.9 && x > width * 0.2 && x < width * 0.75) {
        const band = Math.floor((y - height * 0.25) / (height * 0.065));
        px = band % 2 === 0 ? [250, 250, 250] : [206, 214, 224];
      }
      if (x < 3 || y < 3 || x >= width - 3 || y >= height - 3) px = [60, 60, 60];
      raw.set(px, row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

export const SAMPLE_IMAGES = new Map<string, Uint8Array>([
  ['evid/tela-1.png', makePng(1534, 602)],
  ['evid/tela-2.png', makePng(1200, 900, [90, 130, 90])],
]);

export function sampleDoc(): CtDocument {
  return createCtDocument(
    {
      title: 'Cálculo incorreto da taxa de exemplo',
      ticketId: '900.001',
      priority: 'Alta',
      systemModule: 'Financeiro / Empenho\nPatrimonial / Protocolo',
      author: 'Fulana de Tal',
      analysisTitle: 'Descrição da Demanda',
      context:
        'Foi identificada uma inconsistência fictícia no cálculo da taxa de exemplo, que gerava valores acima do esperado.\nA correção trata apenas o caso do cadastro 123 (chamado de teste 900.002).',
      useCases: [
        {
          status: 'Finalizado',
          items: [
            {
              kind: 'text',
              text: 'Após a correção, acessa o menu: PREFEITURA EXEMPLO > DB:FINANCEIRO > Empenho > Consulta;',
            },
            { kind: 'image', key: 'evid/tela-1.png', width: 1534, height: 602 },
            { kind: 'text', text: 'Conferência no banco:' },
            {
              kind: 'code',
              text: 'SELECT *\nFROM tabela_exemplo\nWHERE codigo = 123 AND valor > 0',
            },
          ],
        },
        {
          title: 'Caso de Uso 2 - Cadastro inválido',
          status: 'Pendente',
          items: [
            { kind: 'text', text: 'Primeira linha\n\nTerceira linha após linha em branco.' },
            {
              kind: 'image',
              key: 'evid/tela-2.png',
              width: 1200,
              height: 900,
              caption: 'Tela de cadastro com o erro',
            },
          ],
        },
      ],
      versions: [
        {
          version: '1.0',
          date: '12/11/2026',
          description: 'Criação do documento',
          author: 'Fulana de Tal',
        },
        {
          version: '1.1',
          date: '13/11/2026',
          description: 'Ajuste dos casos de uso',
          author: 'Beltrano',
        },
      ],
    },
    new Date('2026-11-12T12:00:00Z'),
  );
}

/** A model with every knob turned (and a small PNG logo). */
export function customLayout(overrides: Partial<CtLayout> = {}): CtLayout {
  const logo = `data:image/png;base64,${Buffer.from(makePng(120, 40)).toString('base64')}`;
  return ctLayoutSchema.parse({
    title: 'Relatório de Teste Acme',
    kicker: 'QUALIDADE',
    headerText: 'Acme Corp - Controle de Qualidade',
    footerText: 'Uso restrito da Acme',
    primaryColor: '#AA1122',
    accentColor: '#0055CC',
    fontFamily: 'Georgia',
    logo,
    logoPosition: 'left',
    ...overrides,
  });
}
