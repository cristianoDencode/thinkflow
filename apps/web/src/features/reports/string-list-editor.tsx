import { Plus, X } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/form';

/** Editable list of short texts (directives, rules, questions). */
export function StringListEditor({
  label,
  items,
  onChange,
  placeholder,
  addLabel,
  max,
}: {
  /** Singular label used for accessible names ("Diretriz 1"). */
  label: string;
  items: string[];
  onChange(items: string[]): void;
  placeholder?: string;
  addLabel: string;
  max: number;
}) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            aria-label={`${label} ${i + 1}`}
            value={item}
            placeholder={placeholder}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remover ${label.toLowerCase()} ${i + 1}`}
            onClick={() => onChange(items.filter((_, j) => j !== i))}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={items.length >= max}
        onClick={() => onChange([...items, ''])}
      >
        <Plus className="h-4 w-4" /> {addLabel}
      </Button>
    </div>
  );
}
