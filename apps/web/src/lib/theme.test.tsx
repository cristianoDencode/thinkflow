import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from './theme';

function Probe() {
  const { resolved, toggle, setPreference } = useTheme();
  return (
    <div>
      <span data-testid="resolved">{resolved}</span>
      <button onClick={toggle}>toggle</button>
      <button onClick={() => setPreference('system')}>system</button>
    </div>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('follows the system preference by default and toggles + persists', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('light');
    act(() => screen.getByText('toggle').click());
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('thinkflow-theme')).toBe('dark');
    act(() => screen.getByText('toggle').click());
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('restores a saved preference', () => {
    localStorage.setItem('thinkflow-theme', 'dark');
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('resolved')).toHaveTextContent('dark');
  });
});
