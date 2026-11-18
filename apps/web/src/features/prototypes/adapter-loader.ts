import type { AdapterFactory } from './editor-adapter';

/** Dynamic import: GrapesJS (and its CSS) ends up in a separate chunk, fetched on first use. */
export async function loadEditorAdapter(): Promise<AdapterFactory> {
  const mod = await import('./grapes-adapter');
  return mod.createGrapesAdapter;
}
