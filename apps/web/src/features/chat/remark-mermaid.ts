interface MdNode {
  type: string;
  lang?: string | null;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/**
 * Turns ```mermaid code nodes into a `<div data-mermaid="...">` so rehype-highlight skips them
 * and the `div` component override can render the diagram.
 */
export function remarkMermaid() {
  return (tree: MdNode) => {
    const walk = (node: MdNode) => {
      if (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid') {
        node.data = {
          ...node.data,
          hName: 'div',
          hProperties: { 'data-mermaid': node.value ?? '' },
          hChildren: [],
        };
        return;
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
