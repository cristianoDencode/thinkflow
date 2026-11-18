import { describe, expect, it } from 'vitest';
import { frameMatchTier, rankFrameUrls } from '../../src/contexts/testing/domain/frame-match';
import { isEmptySpaceTarget } from '../../src/contexts/testing/domain/locators';

const H = 'http://erp.local';

describe('frameMatchTier', () => {
  it('ranks identical, same path without the query, and numbered windows', () => {
    const recorded = `${H}/w/1/emp.php?e60_codemp=1&x=a#top`;
    expect(frameMatchTier(recorded, recorded)).toBe(0);
    expect(frameMatchTier(recorded, `${H}/w/1/emp.php?e60_codemp=99`)).toBe(1);
    expect(frameMatchTier(recorded, `${H}/w/7/emp.php?e60_codemp=99`)).toBe(2);
    expect(frameMatchTier(`${H}/w/1/a/w/2/b`, `${H}/w/4/a/w/9/b`)).toBe(2);
  });

  it('does not match another path, another origin or non-numbered segments', () => {
    expect(frameMatchTier(`${H}/w/1/emp.php`, `${H}/w/1/outra.php`)).toBeNull();
    expect(frameMatchTier(`${H}/w/1/emp.php`, 'http://outro.local/w/1/emp.php')).toBeNull();
    expect(frameMatchTier(`${H}/w/x/emp.php`, `${H}/w/y/emp.php`)).toBeNull();
    expect(frameMatchTier(`${H}/w/1/emp.php`, 'about:blank')).toBeNull();
  });
});

describe('rankFrameUrls', () => {
  it('orders the closest tier first, document order within a tier, unrelated last', () => {
    const urls = [
      `${H}/`, // main page
      `${H}/w/2/emp.php?c=1`, // numbered
      `${H}/w/9/other.php`, // unrelated
      `${H}/w/5/emp.php?c=7`, // same path
      `${H}/w/5/emp.php?c=1`, // same path
      `${H}/w/5/emp.php?c=3&q=1`, // exact
    ];
    expect(rankFrameUrls(`${H}/w/5/emp.php?c=3&q=1`, urls)).toEqual([5, 3, 4, 1, 0, 2]);
  });
});

describe('isEmptySpaceTarget', () => {
  const t = (...selectors: string[]) => ({
    locators: selectors.map((selector) => ({ kind: 'css' as const, selector })),
  });
  it('is true only when every locator is the page background', () => {
    expect(isEmptySpaceTarget(t('html'))).toBe(true);
    expect(isEmptySpaceTarget(t('body', 'html'))).toBe(true);
    expect(isEmptySpaceTarget(t('html > body'))).toBe(true);
    expect(isEmptySpaceTarget(t('html', '#salvar'))).toBe(false);
    expect(isEmptySpaceTarget(t('body > div'))).toBe(false);
    expect(isEmptySpaceTarget({ locators: [{ kind: 'text', text: 'html' }] })).toBe(false);
    expect(isEmptySpaceTarget({ locators: [] })).toBe(false);
    expect(isEmptySpaceTarget(null)).toBe(false);
  });
});
