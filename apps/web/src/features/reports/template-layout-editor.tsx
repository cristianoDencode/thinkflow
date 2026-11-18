import {
  TEMPLATE_LIMITS,
  TEMPLATE_THEME_LABELS,
  templateThemeSchema,
  type TemplateLayout,
  type TemplateTheme,
} from '@thinkflow/shared';
import { ImagePlus, X } from 'lucide-react';
import { useRef } from 'react';
import { Button } from '../../components/ui/button';
import { Field, Input, Select, Switch } from '../../components/ui/form';
import { notify } from '../../lib/notify';
import { cn } from '../../lib/utils';

function SwitchRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <div className="flex items-center gap-3">
      <Switch checked={checked} onChange={onChange} label={label} />
      <span className="text-sm">{label}</span>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  error: string | undefined;
}) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <Field label={label} error={error}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} (seletor)`}
          value={valid ? value : '#000000'}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-14 cursor-pointer rounded-xl border border-border bg-bg-elevated p-1"
        />
        <Input
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono"
          maxLength={7}
        />
      </div>
    </Field>
  );
}

/** Miniature of the cover page with the chosen colors. */
function CoverPreview({ layout, title }: { layout: TemplateLayout; title: string }) {
  const compact = layout.theme === 'compacto';
  return (
    <div
      className="flex aspect-[1/1.2] w-full max-w-[220px] flex-col justify-between overflow-hidden rounded-lg border border-border bg-white p-4 text-neutral-900 shadow-sm"
      role="img"
      aria-label="Pré-visualização das cores da capa"
    >
      <div>
        {layout.logo && <img src={layout.logo} alt="" className="mb-2 max-h-8 w-auto" />}
        <div className="h-1.5 w-12 rounded-full" style={{ backgroundColor: layout.accentColor }} />
        <p
          className={cn('mt-3 font-semibold leading-tight', compact ? 'text-xs' : 'text-sm')}
          style={{ color: layout.primaryColor }}
        >
          {title || 'Título do documento'}
        </p>
        {layout.coverSubtitle && (
          <p className="mt-1 text-[10px] text-neutral-600">{layout.coverSubtitle}</p>
        )}
      </div>
      <div
        className="h-6 rounded-md"
        style={{ backgroundColor: layout.primaryColor }}
        aria-hidden
      />
    </div>
  );
}

export function TemplateLayoutEditor({
  layout,
  onChange,
  errors,
  previewTitle,
  readOnly,
}: {
  layout: TemplateLayout;
  onChange(layout: TemplateLayout): void;
  errors: Record<string, string>;
  previewTitle: string;
  readOnly: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<TemplateLayout>) => onChange({ ...layout, ...patch });

  const pickLogo = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) {
      notify.warning('A logo deve ser uma imagem PNG ou JPEG.');
      return;
    }
    if (file.size > TEMPLATE_LIMITS.maxLogoBytes) {
      notify.warning(`A logo deve ter no máximo ${TEMPLATE_LIMITS.maxLogoBytes / 1000} KB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') set({ logo: reader.result });
    };
    reader.onerror = () => notify.error('Não foi possível ler a imagem.');
    reader.readAsDataURL(file);
  };

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_auto]">
      <div className="flex flex-col gap-4">
        <Field label="Tema visual" htmlFor="layout-theme">
          <Select
            id="layout-theme"
            value={layout.theme}
            onChange={(e) => set({ theme: e.target.value as TemplateTheme })}
          >
            {templateThemeSchema.options.map((t) => (
              <option key={t} value={t}>
                {TEMPLATE_THEME_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ColorField
            label="Cor principal"
            value={layout.primaryColor}
            onChange={(primaryColor) => set({ primaryColor })}
            error={errors['spec.layout.primaryColor']}
          />
          <ColorField
            label="Cor de destaque"
            value={layout.accentColor}
            onChange={(accentColor) => set({ accentColor })}
            error={errors['spec.layout.accentColor']}
          />
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <SwitchRow label="Capa" checked={layout.cover} onChange={(cover) => set({ cover })} />
          <SwitchRow label="Sumário" checked={layout.toc} onChange={(toc) => set({ toc })} />
          <SwitchRow
            label="Quebra de página antes de cada seção"
            checked={layout.sectionPageBreak}
            onChange={(sectionPageBreak) => set({ sectionPageBreak })}
          />
        </div>
        <Field label="Subtítulo da capa" htmlFor="layout-subtitle">
          <Input
            id="layout-subtitle"
            value={layout.coverSubtitle}
            onChange={(e) => set({ coverSubtitle: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Texto do cabeçalho" htmlFor="layout-header">
            <Input
              id="layout-header"
              value={layout.headerText}
              onChange={(e) => set({ headerText: e.target.value })}
            />
          </Field>
          <Field label="Texto do rodapé" htmlFor="layout-footer">
            <Input
              id="layout-footer"
              value={layout.footerText}
              onChange={(e) => set({ footerText: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Tamanho da página" htmlFor="layout-page">
          <Select
            id="layout-page"
            value={layout.pageSize}
            onChange={(e) => set({ pageSize: e.target.value as TemplateLayout['pageSize'] })}
          >
            <option value="A4">A4</option>
            <option value="Letter">Carta (Letter)</option>
          </Select>
        </Field>
        <Field label="Logo" hint="PNG ou JPEG, até 200 KB." error={errors['spec.layout.logo']}>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg"
              className="sr-only"
              aria-label="Enviar logo"
              disabled={readOnly}
              onChange={(e) => {
                pickLogo(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={readOnly}
              onClick={() => fileInput.current?.click()}
            >
              <ImagePlus className="h-4 w-4" /> {layout.logo ? 'Trocar logo' : 'Enviar logo'}
            </Button>
            {layout.logo && (
              <>
                <img
                  src={layout.logo}
                  alt="Logo atual"
                  className="h-8 w-auto rounded border border-border bg-white p-0.5"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={readOnly}
                  onClick={() => set({ logo: null })}
                >
                  <X className="h-4 w-4" /> Remover logo
                </Button>
              </>
            )}
          </div>
        </Field>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Pré-visualização</span>
        <CoverPreview layout={layout} title={previewTitle} />
      </div>
    </div>
  );
}
