import { expect, test, type APIRequestContext } from '@playwright/test';

const PASSWORD = 'senha-forte-123';

/** Works whether or not the smoke spec already ran. */
async function ensureSession(api: APIRequestContext) {
  const status = (await (await api.get('/api/auth/status')).json()) as { needsSetup?: boolean };
  if (status.needsSetup)
    expect(
      (await api.post('/api/auth/setup', { data: { name: 'Teste', password: PASSWORD } })).ok(),
    ).toBe(true);
  else
    expect((await api.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await ensureSession(page.request);
});

// The recording itself opens a visible browser window on the server machine (not available in
// CI); this covers everything around it in a real browser: the Konva editor, the document.
test('Testes: print de um passo anotado no editor e documento pronto para colar', async ({
  page,
}) => {
  const api = page.request;
  const created = await api.post('/api/tests/sessions', {
    data: { name: 'Cadastro E2E', startUrl: 'https://exemplo.gov.br/login' },
  });
  expect(created.status()).toBe(201);
  const session = (await created.json()) as { id: string };

  // a real PNG to annotate: a screenshot of the app itself
  await page.goto('/tests');
  await expect(page.getByRole('heading', { name: 'Testes' })).toBeVisible();
  const png = await page.screenshot({ type: 'png' });
  // a pasted PNG becomes a "Print da tela" step holding it
  const upload = await api.post(`/api/tests/sessions/${session.id}/steps/captures`, {
    multipart: { image: { name: 'tela.png', mimeType: 'image/png', buffer: png } },
  });
  expect(upload.status()).toBe(201);
  const evidence = (await upload.json()) as { id: string; width: number; height: number };

  // the menu leads to the session
  await page.getByRole('navigation').getByRole('link', { name: 'Testes' }).click();
  await page.getByRole('link', { name: 'Cadastro E2E' }).first().click();
  await expect(page.getByRole('tab', { name: /Evidências/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Editar print do passo 1' }).click();

  const toolbar = page.getByRole('toolbar', { name: 'Ferramentas de anotação' });
  await expect(toolbar).toBeVisible();
  const canvas = page.locator('.konvajs-content canvas').last();
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;

  // rectangle: drag on the image
  await toolbar.getByRole('button', { name: 'Retângulo' }).click();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 120, { steps: 5 });
  await page.mouse.up();
  // step number: one click
  await toolbar.getByRole('button', { name: 'Número de passo' }).click();
  await page.mouse.click(box.x + 260, box.y + 80);
  // text: click where it goes, type right on the image, Enter
  await toolbar.getByRole('button', { name: 'Texto' }).click();
  await page.mouse.click(box.x + 60, box.y + 160);
  const textBox = page.getByLabel('Texto da anotação');
  await expect(textBox).toBeFocused();
  await page.keyboard.type('Botão Entrar');
  await page.keyboard.press('Enter');
  await expect(textBox).toBeHidden();

  await page.getByLabel('Comentário').fill('Tela inicial do módulo de testes');
  await page.getByRole('button', { name: 'Salvar print' }).click();
  // exporting the PNG at the screenshot's resolution takes a moment: wait for the save itself
  await expect(page.getByText('Print salvo')).toBeVisible();
  await expect(toolbar).toBeHidden();

  type Detail = {
    images: Record<
      string,
      {
        annotated: boolean;
        annotations: { type: string; n?: number; text?: string }[];
        crop: unknown;
        imageUrl: string;
        comment: string;
      }
    >;
  };
  const read = async () =>
    Object.values(
      ((await (await api.get(`/api/tests/sessions/${session.id}`)).json()) as Detail).images,
    )[0]!;
  await expect.poll(async () => (await read()).annotated).toBe(true);
  const saved = await read();
  expect(saved.comment).toBe('Tela inicial do módulo de testes');
  expect(saved.annotations.map((a) => a.type)).toEqual(['rect', 'badge', 'text']);
  expect(saved.annotations[1]!.n).toBe(1);
  expect(saved.annotations[2]!.text).toBe('Botão Entrar');
  // always the whole browser screen, flattened at the screenshot's own resolution
  expect(saved.crop).toBeNull();
  const annotated = await api.get(saved.imageUrl);
  expect(annotated.headers()['content-type']).toBe('image/png');
  const bytes = await annotated.body();
  expect(bytes.readUInt32BE(16)).toBe(evidence.width);
  expect(bytes.readUInt32BE(20)).toBe(evidence.height);

  // the document shows the step's print with its comment, and the downloads answer
  await page.getByRole('tab', { name: 'Documento' }).click();
  const frame = page.frameLocator('iframe[title="Pré-visualização do documento"]');
  await expect(
    frame.getByRole('heading', { name: 'Evidência de teste — Cadastro E2E' }),
  ).toBeVisible();
  await expect(frame.getByText('Tela inicial do módulo de testes')).toBeVisible();
  await expect(frame.locator('img[alt="Passo 1"]')).toBeVisible();
  const zip = await api.get(`/api/tests/sessions/${session.id}/document?format=zip`);
  expect(zip.headers()['content-type']).toBe('application/zip');
  const spec = await api.get(`/api/tests/sessions/${session.id}/document?format=spec`);
  expect(await spec.text()).toContain("import { expect, test } from '@playwright/test';");
});
