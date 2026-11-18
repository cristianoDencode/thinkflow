import fs from 'node:fs';

export interface DisplayEnvironment {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Containers have no screen to show a browser window on. */
  isContainer?: () => boolean;
}

export const defaultIsContainer = (): boolean =>
  fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');

/**
 * Whether this server can open a visible browser window: a desktop (Windows/macOS) or Linux with
 * X11/Wayland, outside a container. Used by the NotebookLM login and the test recorder.
 */
export function canOpenWindow(options: DisplayEnvironment = {}): boolean {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const isContainer = options.isContainer ?? defaultIsContainer;
  const headless = platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY;
  return !headless && !isContainer();
}
