import { expect, test } from '@playwright/test';

const MOCK_PORT = 4910;

test('setup → connection with fallback → chat answer → theme toggle', async ({ page }) => {
  // first run: create the local account
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Configuração inicial' })).toBeVisible();
  await page.getByLabel('Seu nome').fill('Cristiano Souza');
  await page.getByLabel('Cargo (opcional)').fill('Analista de Sistemas');
  await page.getByLabel('Senha').fill('senha-forte-123');
  await page.getByRole('button', { name: 'Criar acesso' }).click();
  await expect(page.getByText('Como posso te ajudar hoje?')).toBeVisible();

  // a broken connection (priority 1) and a working one (priority 2)
  const api = page.request;
  for (const [name, port, priority] of [
    ['quebrada', 4999, 1],
    ['mock', MOCK_PORT, 2],
  ] as const) {
    const res = await api.post('/api/connections', {
      data: {
        providerId: 'custom-openai',
        name,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        priority,
        defaultModel: 'mock-model',
      },
    });
    expect(res.status()).toBe(201);
  }
  await api.post('/api/combos', {
    data: {
      name: 'thinkflow/default',
      targets: [{ providerId: 'custom-openai', model: 'mock-model' }],
    },
  });

  // chat
  await page.reload();
  await page.getByText('Criar um PRD').click();
  await page.getByLabel('Pergunta').pressSequentially('login social');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByText(/Resposta mock #1/)).toBeVisible();
  await expect(page.getByText('Raciocínio concluído')).toBeVisible();

  // Mermaid: an unfenced flowchart is normalized and drawn by the (lazy-loaded) real mermaid
  await page.getByLabel('Pergunta').pressSequentially('faça um diagrama do fluxo');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.locator('article svg[id^="tf-mmd-"]').first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('Desenhando diagrama…')).toHaveCount(0);

  // routing state is visible in Conexões, which opens as a modal over the chat
  await page.getByRole('button', { name: 'Menu do usuário' }).click();
  await page.getByRole('menuitem', { name: /Conexões/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Conexões e roteamento' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/\/connections$/);
  await expect(dialog.getByText(/Cooldown|Erro/).first()).toBeVisible();
  await dialog.getByRole('tab', { name: /Atividade/ }).click();
  await expect(dialog.getByText('rede/timeout').first()).toBeVisible();
  // the chat behind stays mounted (conversation is still there); Escape closes the modal
  await expect(page.getByText(/Resposta mock #1/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page).not.toHaveURL(/\/connections/);
  await expect(page.getByText(/Resposta mock #1/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Menu do usuário' })).toBeFocused();

  // a deep link to the same page renders it as a full page, no dialog
  await page.goto('/connections');
  await expect(page.getByRole('heading', { name: 'Conexões e roteamento' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // theme toggle
  const html = page.locator('html');
  const wasDark = (await html.getAttribute('class'))?.includes('dark') ?? false;
  await page
    .getByRole('button', { name: wasDark ? 'Ativar tema claro' : 'Ativar tema escuro' })
    .click();
  if (wasDark) await expect(html).not.toHaveClass(/dark/);
  else await expect(html).toHaveClass(/dark/);
});
