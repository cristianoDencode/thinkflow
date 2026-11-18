import { describe, expect, it } from 'vitest';
import { isSafeSvg, SVG_MAX_CHARS } from '../../src/contexts/reports/domain/svg-guard';

const wrap = (inner: string, attrs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" ${attrs}>${inner}</svg>`;

describe('isSafeSvg', () => {
  it('accepts a typical Mermaid output', () => {
    const svg = wrap(
      '<style>#m1{font-family:Arial}#m1 .node rect{fill:#ececff}#m1 .m{marker-end:url(#arrow)}</style><defs><marker id="arrow"><path d="M0 0"/></marker></defs><g class="node"><rect/><text>Início & fim (x)</text></g><use xlink:href="#arrow"/>',
    );
    expect(isSafeSvg(svg)).toBe(true);
    expect(isSafeSvg(`  \n${svg}`)).toBe(true);
  });

  it('accepts labels that merely look like attributes', () => {
    expect(isSafeSvg(wrap('<text>onde=1 e onclick= são só texto</text>'))).toBe(true);
  });

  it.each([
    ['not an svg', '<div>x</div>'],
    ['empty', ''],
    ['script', wrap('<script>alert(1)</script>')],
    ['SCRIPT upper', wrap('<SCRIPT>alert(1)</SCRIPT>')],
    ['foreignObject', wrap('<foreignObject><div>x</div></foreignObject>')],
    ['iframe', wrap('<iframe src="x"></iframe>')],
    ['event handler', wrap('<rect onclick="x()"/>')],
    ['event handler with quote', wrap('<rect fill="red"onload="x()"/>')],
    ['javascript url', wrap('<a href="javascript:alert(1)"><rect/></a>')],
    ['remote href', wrap('<a href="https://evil.test"><rect/></a>')],
    ['remote xlink', wrap('<use xlink:href="http://evil.test/a.svg#x"/>')],
    ['remote image', wrap('<image href="https://evil.test/a.png"/>')],
    ['css import', wrap('<style>@import url(https://evil.test/a.css);</style>')],
    ['css remote url', wrap('<style>.a{background:url(https://evil.test/a.png)}</style>')],
    ['entity', wrap('<!ENTITY x "y">')],
    ['too big', wrap('x'.repeat(SVG_MAX_CHARS))],
  ])('rejects %s', (_name, svg) => {
    expect(isSafeSvg(svg)).toBe(false);
  });

  it('allows data:image hrefs only', () => {
    expect(isSafeSvg(wrap('<image href="data:image/png;base64,AAAA"/>'))).toBe(true);
    expect(isSafeSvg(wrap('<image href="data:text/html;base64,AAAA"/>'))).toBe(false);
  });
});
