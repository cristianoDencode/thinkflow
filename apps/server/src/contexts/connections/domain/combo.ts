import { DomainError } from '../../../shared/kernel/errors';

export type ComboStrategy = 'priority' | 'round-robin';

export interface ComboTarget {
  providerId: string;
  model: string;
  connectionId?: string | null;
}

export interface ComboProps {
  id: string;
  name: string;
  strategy: ComboStrategy;
  targets: ComboTarget[];
  createdAt: number;
}

/** Aggregate: a named, ordered list of provider/model targets exposed as a virtual model. */
export class Combo {
  private constructor(private props: ComboProps) {
    Combo.validate(props);
  }

  static create(props: ComboProps): Combo {
    return new Combo({ ...props, targets: props.targets.map((t) => ({ ...t })) });
  }

  static restore(props: ComboProps): Combo {
    return new Combo(props);
  }

  private static validate(props: ComboProps): void {
    if (props.targets.length === 0) throw new DomainError('O combo precisa de ao menos um alvo');
    if (!/^[a-zA-Z0-9._/-]+$/.test(props.name)) throw new DomainError('Nome de combo inválido');
  }

  get id() {
    return this.props.id;
  }
  get name() {
    return this.props.name;
  }
  get strategy() {
    return this.props.strategy;
  }
  get targets(): readonly ComboTarget[] {
    return this.props.targets;
  }

  update(changes: Partial<Pick<ComboProps, 'name' | 'strategy' | 'targets'>>): void {
    const next = { ...this.props, ...changes };
    Combo.validate(next);
    this.props = next;
  }

  /** Targets in the order they should be tried for the n-th request. */
  orderedTargets(requestSeq: number): ComboTarget[] {
    const list = [...this.props.targets];
    if (this.props.strategy !== 'round-robin' || list.length < 2) return list;
    const offset = requestSeq % list.length;
    return [...list.slice(offset), ...list.slice(0, offset)];
  }

  toSnapshot(): ComboProps {
    return { ...this.props, targets: this.props.targets.map((t) => ({ ...t })) };
  }
}
