import {
  CT_LAYOUT_FONTS,
  CT_LAYOUT_LIMITS,
  TEMPLATE_LIMITS,
  type CtLayout,
  type CtLayoutFont,
} from '@thinkflow/shared';
import { useQuery } from '@tanstack/react-query';
import { ImagePlus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Field, Input, Select, Switch } from '../../components/ui/form';
import { api } from '../../lib/api';
import { notify } from '../../lib/notify';
import { CT_MODELS_URL } from './ct-models';

function SwitchRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
      <span className="text-sm">{label}</span>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  disabled: boolean;
}) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <Field label={label} error={valid ? null : 'Use o formato #RRGGBB'}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} (seletor)`}
          value={valid ? value : '#000000'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="h-10 w-14 cursor-pointer rounded-xl border border-border bg-bg-elevated p-1"
        />
        <Input
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono"
          maxLength={7}
        />
      </div>
    </Field>
  );
}

/** Live preview: the server renders a sample document with the unsaved look. */
export function CtLayoutPreview({ layout }: { layout: CtLayout }) {
  const [debounced, setDebounced] = useState(layout);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(layout), 350);
    return () => clearTimeout(timer);
  }, [layout]);
  const colorsOk =
    /^#[0-9a-fA-F]{6}$/.test(debounced.primaryColor) &&
    /^#[0-9a-fA-F]{6}$/.test(debounced.accentColor);
  const preview = useQuery({
    queryKey: ['ct-model-preview', JSON.stringify(debounced)],
    queryFn: () => api.post<{ html: string }>(`${CT_MODELS_URL}/preview`, { layout: debounced }),
    enabled: colorsOk && debounced.title.trim().length > 0,
    placeholderData: (previous) => previous,
    staleTime: Infinity,
    gcTime: 0,
  });
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Pré-visualização</span>
      {preview.data ? (
        <iframe
          title="Pré-visualização do modelo"
          // nothing in the sample can run scripts or reach the network
          sandbox=""
          srcDoc={preview.data.html}
          className="h-[60vh] w-full rounded-xl border border-border bg-white"
        />
      ) : (
        <p className="text-sm text-muted">
          {preview.isError ? 'Não foi possível montar a pré-visualização.' : 'Montando…'}
        </p>
      )}
    </div>
  );
}

/** The form of a model's look. The categories of the document (sections, fields) are fixed. */
export function CtLayoutForm({
  layout,
  onChange,
  readOnly,
}: {
  layout: CtLayout;
  onChange(layout: CtLayout): void;
  readOnly: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<CtLayout>) => onChange({ ...layout, ...patch });

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
    <div className="flex flex-col gap-4">
      <Field label="Título do documento" htmlFor="ct-layout-title">
        <Input
          id="ct-layout-title"
          value={layout.title}
          disabled={readOnly}
          maxLength={CT_LAYOUT_LIMITS.maxTitleChars}
          onChange={(e) => set({ title: e.target.value })}
        />
      </Field>
      <Field
        label="Linha acima do título"
        htmlFor="ct-layout-kicker"
        hint="Deixe em branco para não mostrar."
      >
        <Input
          id="ct-layout-kicker"
          value={layout.kicker}
          disabled={readOnly}
          maxLength={CT_LAYOUT_LIMITS.maxKickerChars}
          onChange={(e) => set({ kicker: e.target.value })}
        />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Texto do cabeçalho" htmlFor="ct-layout-header">
          <Input
            id="ct-layout-header"
            value={layout.headerText}
            disabled={readOnly}
            maxLength={CT_LAYOUT_LIMITS.maxHeaderChars}
            onChange={(e) => set({ headerText: e.target.value })}
          />
        </Field>
        <Field
          label="Texto do rodapé"
          htmlFor="ct-layout-footer"
          hint='Aparece antes de "Página X de Y".'
        >
          <Input
            id="ct-layout-footer"
            value={layout.footerText}
            disabled={readOnly}
            maxLength={CT_LAYOUT_LIMITS.maxFooterChars}
            onChange={(e) => set({ footerText: e.target.value })}
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <ColorField
          label="Cor principal"
          value={layout.primaryColor}
          disabled={readOnly}
          onChange={(primaryColor) => set({ primaryColor })}
        />
        <ColorField
          label="Cor de destaque"
          value={layout.accentColor}
          disabled={readOnly}
          onChange={(accentColor) => set({ accentColor })}
        />
      </div>
      <Field label="Fonte" htmlFor="ct-layout-font">
        <Select
          id="ct-layout-font"
          value={layout.fontFamily}
          disabled={readOnly}
          onChange={(e) => set({ fontFamily: e.target.value as CtLayoutFont })}
        >
          {CT_LAYOUT_FONTS.map((font) => (
            <option key={font} value={font}>
              {font}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <SwitchRow
          label="Mostrar cabeçalho"
          checked={layout.showHeader}
          disabled={readOnly}
          onChange={(showHeader) => set({ showHeader })}
        />
        <SwitchRow
          label="Mostrar rodapé"
          checked={layout.showFooter}
          disabled={readOnly}
          onChange={(showFooter) => set({ showFooter })}
        />
      </div>
      <Field label="Logo" hint="PNG ou JPEG, até 200 KB. Aparece no cabeçalho.">
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
      {layout.logo && (
        <Field label="Posição da logo" htmlFor="ct-layout-logo-pos">
          <Select
            id="ct-layout-logo-pos"
            value={layout.logoPosition}
            disabled={readOnly}
            onChange={(e) => set({ logoPosition: e.target.value as CtLayout['logoPosition'] })}
          >
            <option value="right">À direita</option>
            <option value="left">À esquerda</option>
          </Select>
        </Field>
      )}
    </div>
  );
}
