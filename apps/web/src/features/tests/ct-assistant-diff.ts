export interface DiffPart {
  text: string;
  kind: 'same' | 'removed' | 'added';
}

/** Words and the whitespace between them, so joining the parts gives the text back. */
const tokenize = (text: string): string[] => text.match(/\s+|[^\s]+/g) ?? [];

/** Above this many token pairs the LCS table is skipped (the whole text counts as changed). */
const MAX_CELLS = 2_000_000;

/**
 * Word-level diff (longest common subsequence). `before` is the old text with the removed
 * words flagged, `after` the new text with the added ones flagged.
 */
export function wordDiff(before: string, after: string): { before: DiffPart[]; after: DiffPart[] } {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length * b.length > MAX_CELLS) {
    return {
      before: before ? [{ text: before, kind: 'removed' }] : [],
      after: after ? [{ text: after, kind: 'added' }] : [],
    };
  }
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const outBefore: DiffPart[] = [];
  const outAfter: DiffPart[] = [];
  const push = (list: DiffPart[], text: string, kind: DiffPart['kind']) => {
    const last = list.at(-1);
    if (last && last.kind === kind) last.text += text;
    else list.push({ text, kind });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push(outBefore, a[i]!, 'same');
      push(outAfter, b[j]!, 'same');
      i++;
      j++;
    } else if (
      j < b.length &&
      (i === a.length || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)
    ) {
      push(outAfter, b[j]!, 'added');
      j++;
    } else {
      push(outBefore, a[i]!, 'removed');
      i++;
    }
  }
  return { before: outBefore, after: outAfter };
}
