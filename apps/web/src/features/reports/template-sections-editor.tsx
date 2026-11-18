import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TEMPLATE_LIMITS, type TemplateSection } from '@thinkflow/shared';
import { ArrowDown, ArrowUp, ChevronDown, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Field, Input, Select, Textarea } from '../../components/ui/form';
import { cn } from '../../lib/utils';
import { newSection } from './template-draft';

const LEVELS = [
  { value: 'none', label: 'Não' },
  { value: 'optional', label: 'Opcional' },
  { value: 'required', label: 'Obrigatório' },
] as const;

export function TemplateSectionsEditor({
  sections,
  onChange,
  errors,
  readOnly,
}: {
  sections: TemplateSection[];
  onChange(sections: TemplateSection[]): void;
  errors: Record<string, string>;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(sections.length <= 3 ? sections.map((s) => s.id) : []),
  );
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const update = (id: string, patch: Partial<TemplateSection>) =>
    onChange(sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const move = (index: number, to: number) => {
    if (to < 0 || to >= sections.length) return;
    onChange(arrayMove(sections, index, to));
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = sections.findIndex((s) => s.id === active.id);
    const to = sections.findIndex((s) => s.id === over.id);
    if (from >= 0 && to >= 0) onChange(arrayMove(sections, from, to));
  };
  const add = () => {
    const section = newSection(sections);
    setOpen((prev) => new Set(prev).add(section.id));
    onChange([...sections, section]);
  };

  return (
    <div className="flex flex-col gap-3">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <ol className="flex flex-col gap-2">
            {sections.map((section, index) => (
              <SortableSection
                key={section.id}
                section={section}
                index={index}
                count={sections.length}
                expanded={open.has(section.id)}
                titleError={errors[`spec.sections.${index}.title`]}
                readOnly={readOnly}
                onToggle={() => toggle(section.id)}
                onChange={(patch) => update(section.id, patch)}
                onMove={(to) => move(index, to)}
                onRemove={() => onChange(sections.filter((s) => s.id !== section.id))}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
      {errors['spec.sections'] && <p className="text-xs text-danger">{errors['spec.sections']}</p>}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={readOnly || sections.length >= TEMPLATE_LIMITS.maxSections}
        onClick={add}
      >
        <Plus className="h-4 w-4" /> Adicionar seção
      </Button>
    </div>
  );
}

function SortableSection({
  section,
  index,
  count,
  expanded,
  titleError,
  readOnly,
  onToggle,
  onChange,
  onMove,
  onRemove,
}: {
  section: TemplateSection;
  index: number;
  count: number;
  expanded: boolean;
  titleError: string | undefined;
  readOnly: boolean;
  onToggle(): void;
  onChange(patch: Partial<TemplateSection>): void;
  onMove(to: number): void;
  onRemove(): void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: section.id,
    disabled: readOnly,
  });
  const n = index + 1;
  const detailsId = `section-details-${section.id}`;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'rounded-xl border border-border bg-surface p-2.5',
        isDragging && 'z-10 shadow-xl',
      )}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          disabled={readOnly}
          className="cursor-grab touch-none rounded-md p-1 text-subtle hover:text-fg disabled:cursor-default disabled:opacity-50"
          aria-label={`Arrastar seção ${n}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <span className="w-6 text-center text-xs font-semibold text-muted">{n}</span>
        <Input
          aria-label={`Título da seção ${n}`}
          aria-invalid={titleError ? true : undefined}
          value={section.title}
          placeholder="Título da seção"
          onChange={(e) => onChange({ title: e.target.value })}
          className="h-9"
        />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Mover seção ${n} para cima`}
          disabled={readOnly || index === 0}
          onClick={() => onMove(index - 1)}
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Mover seção ${n} para baixo`}
          disabled={readOnly || index === count - 1}
          onClick={() => onMove(index + 1)}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remover seção ${n}`}
          disabled={readOnly || count <= 1}
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${expanded ? 'Recolher' : 'Expandir'} detalhes da seção ${n}`}
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={onToggle}
        >
          <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
        </Button>
      </div>
      {titleError && <p className="mt-1 ml-9 text-xs text-danger">{titleError}</p>}
      {expanded && (
        <div id={detailsId} className="mt-3 flex flex-col gap-3 sm:pl-9">
          <Field label="O que a seção deve conter" htmlFor={`req-${section.id}`}>
            <Textarea
              id={`req-${section.id}`}
              rows={3}
              value={section.requirements}
              placeholder="Requisitos, perguntas a responder, fontes a consultar…"
              onChange={(e) => onChange({ requirements: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Diagrama Mermaid" htmlFor={`dia-${section.id}`}>
              <Select
                id={`dia-${section.id}`}
                value={section.diagram}
                onChange={(e) =>
                  onChange({ diagram: e.target.value as TemplateSection['diagram'] })
                }
              >
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Tabela" htmlFor={`tab-${section.id}`}>
              <Select
                id={`tab-${section.id}`}
                value={section.table}
                onChange={(e) => onChange({ table: e.target.value as TemplateSection['table'] })}
              >
                {LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Máximo de palavras"
              htmlFor={`words-${section.id}`}
              hint="Vazio = sem limite"
            >
              <Input
                id={`words-${section.id}`}
                type="number"
                min={50}
                max={5000}
                value={section.maxWords ?? ''}
                onChange={(e) =>
                  onChange({ maxWords: e.target.value === '' ? null : Number(e.target.value) })
                }
              />
            </Field>
          </div>
        </div>
      )}
    </li>
  );
}
