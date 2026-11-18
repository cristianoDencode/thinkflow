import type { PrototypeBlockDto } from '@thinkflow/shared';
import { Boxes, Pencil, Plus, Star } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog, ConfirmButton } from '../../components/ui/dialog';
import { Field, Input } from '../../components/ui/form';
import { favoriteTitle, isFavorite } from './favorites';

function BlockRow({
  block,
  favorite,
  onInsert,
  onRename,
  onDelete,
}: {
  block: PrototypeBlockDto;
  favorite: boolean;
  onInsert(block: PrototypeBlockDto): void;
  onRename(block: PrototypeBlockDto): void;
  onDelete(block: PrototypeBlockDto): void;
}) {
  return (
    <li className="flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-surface-hover">
      <span
        className="min-w-0 flex-1 truncate text-sm"
        title={favorite ? favoriteTitle(block) : block.name}
      >
        {favorite && <span aria-hidden>⭐ </span>}
        {block.name}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Inserir ${block.name}`}
        title="Inserir no protótipo"
        onClick={() => onInsert(block)}
      >
        <Plus className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Renomear ${favorite ? 'favorito' : 'bloco'} ${block.name}`}
        title="Renomear"
        onClick={() => onRename(block)}
      >
        <Pencil className="h-4 w-4" />
      </Button>
      <ConfirmButton
        label={`Excluir ${favorite ? 'favorito' : 'bloco'} ${block.name}`}
        onConfirm={() => onDelete(block)}
      >
        <span aria-hidden>×</span>
      </ConfirmButton>
    </li>
  );
}

/**
 * Favorites of the e-Cidade palette and "Meus blocos": managed here (insert / rename / delete);
 * they also appear draggable in the palette.
 */
export function UserBlocksList({
  blocks,
  onInsert,
  onRename,
  onDelete,
}: {
  blocks: PrototypeBlockDto[];
  onInsert(block: PrototypeBlockDto): void;
  onRename(block: PrototypeBlockDto, name: string): void;
  onDelete(block: PrototypeBlockDto): void;
}) {
  const [renaming, setRenaming] = useState<PrototypeBlockDto | null>(null);
  const favorites = blocks.filter(isFavorite);
  const mine = blocks.filter((b) => !isFavorite(b));
  const rowProps = { onInsert, onRename: setRenaming, onDelete };
  return (
    <>
      <section aria-label="Favoritos" className="border-t border-border">
        <h3 className="flex items-center gap-1.5 bg-surface-2 px-3 py-2 text-xs font-semibold">
          <Star className="h-3.5 w-3.5" aria-hidden /> Favoritos
        </h3>
        {favorites.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted">
            Use o ⭐ de um item de “Desta tela” (ou do componente selecionado) para guardá-lo na
            paleta (categoria e-Cidade) e reaproveitá-lo em qualquer protótipo.
          </p>
        ) : (
          <ul className="px-1 py-1">
            {favorites.map((b) => (
              <BlockRow key={b.id} block={b} favorite {...rowProps} />
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Meus blocos" className="border-t border-border">
        <h3 className="flex items-center gap-1.5 bg-surface-2 px-3 py-2 text-xs font-semibold">
          <Boxes className="h-3.5 w-3.5" aria-hidden /> Meus blocos
        </h3>
        {mine.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted">
            Selecione um elemento no canvas e use “Salvar como bloco” para reaproveitá-lo.
          </p>
        ) : (
          <ul className="px-1 py-1">
            {mine.map((b) => (
              <BlockRow key={b.id} block={b} favorite={false} {...rowProps} />
            ))}
          </ul>
        )}
      </section>
      {renaming && (
        <RenameBlockDialog
          block={renaming}
          onSave={(name) => {
            onRename(renaming, name);
            setRenaming(null);
          }}
          onClose={() => setRenaming(null)}
        />
      )}
    </>
  );
}

function RenameBlockDialog({
  block,
  onSave,
  onClose,
}: {
  block: PrototypeBlockDto;
  onSave(name: string): void;
  onClose(): void;
}) {
  const [name, setName] = useState(block.name);
  const submit = () => name.trim() && onSave(name.trim());
  return (
    <Dialog
      open
      onClose={onClose}
      title={isFavorite(block) ? 'Renomear favorito' : 'Renomear bloco'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit}>Salvar</Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Nome" htmlFor="block-rename">
          <Input
            id="block-rename"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </form>
    </Dialog>
  );
}

/** Same structure favorited twice: replace the old favorite or keep both. */
export function DuplicateFavoriteDialog({
  existing,
  saving,
  onReplace,
  onKeepBoth,
  onClose,
}: {
  existing: PrototypeBlockDto;
  saving: boolean;
  onReplace(): void;
  onKeepBoth(): void;
  onClose(): void;
}) {
  return (
    <Dialog
      open
      onClose={onClose}
      title="Já existe um favorito igual"
      description={`“${existing.name}” tem a mesma estrutura deste componente.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button variant="secondary" onClick={onKeepBoth} disabled={saving}>
            Manter os dois
          </Button>
          <Button loading={saving} onClick={onReplace}>
            Substituir
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">
        Substituir troca o favorito antigo por este (o nome do novo é usado). Manter os dois salva
        uma segunda cópia na paleta.
      </p>
    </Dialog>
  );
}

export function SaveBlockDialog({
  defaultName,
  saving,
  error,
  onSave,
  onClose,
}: {
  defaultName: string;
  saving: boolean;
  error: string | null;
  onSave(name: string): void;
  onClose(): void;
}) {
  const [name, setName] = useState(defaultName);
  const submit = () => name.trim() && onSave(name.trim());
  return (
    <Dialog
      open
      onClose={onClose}
      title="Salvar seleção como bloco"
      description="O bloco fica disponível em “Meus blocos” para qualquer protótipo."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={saving} onClick={submit}>
            Salvar bloco
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Nome do bloco" htmlFor="block-name">
          <Input
            id="block-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
