import { useQueryClient } from '@tanstack/react-query';
import type { LibrarySettings } from '@thinkflow/shared';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Field, Input, Select } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { notify } from '../../lib/notify';
import { keys, useLibrarySettings, useModelOptions } from '../../lib/queries';

const LANGUAGES_RE = /^[a-z_]+(\+[a-z_]+)*$/;

export function LibrarySettingsCard() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useLibrarySettings();
  const { data: models = [] } = useModelOptions();
  const [form, setForm] = useState<LibrarySettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  if (isLoading || !form)
    return error ? (
      <p className="text-sm text-danger">{errorMessage(error)}</p>
    ) : (
      <p className="text-sm text-muted">Carregando…</p>
    );

  const languagesValid = LANGUAGES_RE.test(form.ocrLanguages.trim());
  const dirty = JSON.stringify(form) !== JSON.stringify(data);

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.put<LibrarySettings>('/api/library/settings', {
        ...form,
        ocrLanguages: form.ocrLanguages.trim(),
      });
      queryClient.setQueryData([...keys.libraries, 'settings'], saved);
      setForm(saved);
      notify.success('Configurações salvas');
    } catch (err) {
      notify.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="flex max-w-2xl flex-col gap-4 p-5">
      <div>
        <h2 className="font-medium">Reconhecimento de texto em imagens (OCR)</h2>
        <p className="mt-0.5 text-sm text-muted">
          Define como o texto é extraído de imagens e PDFs escaneados.
        </p>
      </div>
      <Field label="Modo de OCR" htmlFor="ocr-mode">
        <Select
          id="ocr-mode"
          value={form.ocr}
          onChange={(e) => setForm({ ...form, ocr: e.target.value as LibrarySettings['ocr'] })}
        >
          <option value="local">Local (Tesseract, privado)</option>
          <option value="vision">
            IA com visão (usa sua cota; a imagem é enviada ao provider)
          </option>
          <option value="off">Desativado</option>
        </Select>
      </Field>
      {form.ocr === 'vision' && (
        <Field
          label="Modelo com visão"
          htmlFor="ocr-model"
          hint="Vazio = primeiro modelo disponível. Imagens são enviadas sem filtro de dados pessoais; prefira o OCR local."
        >
          <Select
            id="ocr-model"
            value={form.ocrModel}
            onChange={(e) => setForm({ ...form, ocrModel: e.target.value })}
          >
            <option value="">Automático</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {form.ocr === 'local' && (
        <Field
          label="Idiomas do OCR"
          htmlFor="ocr-languages"
          hint="Códigos do Tesseract separados por +, ex.: por+eng."
          error={languagesValid ? null : 'Use códigos como por+eng'}
        >
          <Input
            id="ocr-languages"
            value={form.ocrLanguages}
            onChange={(e) => setForm({ ...form, ocrLanguages: e.target.value })}
          />
        </Field>
      )}
      <div>
        <Button onClick={() => void save()} loading={saving} disabled={!dirty || !languagesValid}>
          Salvar
        </Button>
      </div>
    </Card>
  );
}
