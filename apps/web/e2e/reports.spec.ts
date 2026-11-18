import { expect, test, type APIRequestContext } from '@playwright/test';

const MOCK_PORT = 4910;
const PASSWORD = 'senha-forte-123';

/** Works whether or not the smoke spec already ran: creates the account/connection when missing. */
async function ensureSession(api: APIRequestContext) {
  const status = (await (await api.get('/api/auth/status')).json()) as { needsSetup?: boolean };
  if (status.needsSetup)
    expect(
      (await api.post('/api/auth/setup', { data: { name: 'Teste', password: PASSWORD } })).ok(),
    ).toBe(true);
  else
    expect((await api.post('/api/auth/login', { data: { password: PASSWORD } })).ok()).toBe(true);

  const connections = (await (await api.get('/api/connections')).json()) as unknown[];
  if (connections.length === 0) {
    await api.post('/api/connections', {
      data: {
        providerId: 'custom-openai',
        name: 'mock',
        baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
        priority: 1,
        defaultModel: 'mock-model',
      },
    });
    await api.post('/api/combos', {
      data: {
        name: 'thinkflow/default',
        targets: [{ providerId: 'custom-openai', model: 'mock-model' }],
      },
    });
  }
}

test.beforeEach(async ({ page }) => {
  await ensureSession(page.request);
});

test('relatório a partir de um modelo: lista, geração, seções e download em Markdown', async ({
  page,
}) => {
  await page.goto('/reports?tab=modelos');
  await expect(page.getByText('Análise técnica (genérico)')).toBeVisible();
  await expect(page.getByText('Guia do Analista — cálculo de débitos (e-Cidade)')).toBeVisible();

  await page.goto('/reports');
  await page
    .getByRole('button', { name: /Novo relatório/ })
    .first()
    .click();
  await page.getByLabel(/^Assunto/).fill('juros de mora');
  await page.getByLabel(/^Público/).fill('analistas');
  await page.getByRole('button', { name: 'Gerar', exact: true }).click();

  await expect(page).toHaveURL(/\/reports\/[^/]+$/);
  // the mock answers plain text, so the pipeline runs its fallback paths
  await expect(page.getByText('Concluído').first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole('heading', { name: /Resumo executivo/ })).toBeVisible();
  await expect(page.getByText(/Resposta mock/).first()).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Markdown' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.md$/);

  // PDF depends on a local Chromium: only asserted when the renderer is available
  const id = page.url().split('/').pop();
  const renderer = (await (await page.request.get('/api/reports/renderer')).json()) as {
    pdf?: boolean;
    available?: boolean;
  };
  if (renderer.pdf ?? renderer.available) {
    const pdf = await page.request.get(`/api/reports/${id}/pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()['content-type']).toContain('application/pdf');
  }
});

test('modo documento no chat: perguntas, confirmação e cartão de progresso', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Gerar um relatório/ }).click();
  await expect(page.getByLabel('Modelo de documento')).toBeVisible();

  await page
    .getByLabel('Pergunta')
    .pressSequentially('juros de mora para analistas CONFIRMO_GERAR');
  await page.getByRole('button', { name: 'Enviar' }).click();

  const card = page.getByRole('region', { name: /em geração/ });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByRole('link', { name: 'Abrir' })).toBeVisible();
  await expect(page.getByText('<gerar_documento>')).toHaveCount(0);
});
