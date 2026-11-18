import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { Composer, type ComposerSettings } from './composer';

const settings: ComposerSettings = {
  mode: 'chat',
  model: 'groq/llama',
  useMcp: false,
  permissionMode: 'plan',
  cwd: '',
  libraryId: null,
  preset: null,
};

function renderComposer(privacyEnabled: boolean) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Composer
          settings={settings}
          onSettingsChange={() => undefined}
          models={[]}
          streaming={false}
          onSend={() => undefined}
          onStop={() => undefined}
          privacyEnabled={privacyEnabled}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function attach(file: File) {
  const user = userEvent.setup();
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, file);
}

describe('composer privacy notice', () => {
  it('warns about images when the firewall is on', async () => {
    renderComposer(true);
    await attach(new File(['x'], 'foto.png', { type: 'image/png' }));
    await waitFor(() =>
      expect(screen.getByText('Imagens são enviadas sem filtro de dados pessoais.')).toBeTruthy(),
    );
  });

  it('stays quiet for text files and when the firewall is off', async () => {
    const { unmount } = renderComposer(true);
    await attach(new File(['olá'], 'nota.txt', { type: 'text/plain' }));
    await waitFor(() => expect(screen.getByText('nota.txt')).toBeTruthy());
    expect(screen.queryByText(/sem filtro de dados pessoais/)).toBeNull();
    unmount();

    renderComposer(false);
    await attach(new File(['x'], 'foto.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByText('foto.png')).toBeTruthy());
    expect(screen.queryByText(/sem filtro de dados pessoais/)).toBeNull();
  });
});
