import { describe, expect, it } from 'vitest';
import { TF_EDITS_MARKER, frameCanvasCss, joinStoredCss, splitStoredCss } from './base-css';

describe('stored css: captured base + editor edits', () => {
  it('joins base and edits around the marker, and splits them back', () => {
    const css = joinStoredCss('html,body{height:100%}', '#i1{color:red;}');
    expect(css).toBe(`html,body{height:100%}\n${TF_EDITS_MARKER}\n#i1{color:red;}`);
    expect(splitStoredCss(css)).toEqual({
      base: 'html,body{height:100%}',
      edits: '#i1{color:red;}',
    });
  });

  it('has no marker when nothing was edited', () => {
    expect(joinStoredCss('a{b:c}', '')).toBe('a{b:c}');
  });

  it('a legacy prototype (no marker) is all base', () => {
    expect(splitStoredCss('a{b:c}.x{y:z}')).toEqual({ base: 'a{b:c}.x{y:z}', edits: '' });
  });

  it('tolerates spacing differences in the marker', () => {
    expect(splitStoredCss('a{b:c}/*tf-edits*/.e{f:g}')).toEqual({
      base: 'a{b:c}',
      edits: '.e{f:g}',
    });
  });
});

describe('frame canvas css', () => {
  it('pins the page to the prototype height, never a viewport-relative or auto height', () => {
    const css = frameCanvasCss(857);
    expect(css).toContain('html{height:857px !important');
    expect(css).toContain('min-height:857px !important');
    expect(css).not.toMatch(/vh|%|auto/);
  });
});
