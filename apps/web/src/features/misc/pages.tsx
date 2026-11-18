import { useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { ThemeToggle } from '../../components/layout/app-layout';
import { Logo } from '../../components/layout/logo';
import { Button } from '../../components/ui/button';
import { Card, PageHeader } from '../../components/ui/card';
import { Field, Input } from '../../components/ui/form';
import { api, errorMessage } from '../../lib/api';
import { keys, useAuthStatus } from '../../lib/queries';

export function LoginPage() {
  const { data, isLoading } = useAuthStatus();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isLoading) return null;
  if (data?.authenticated) return <Navigate to="/" replace />;
  const setup = data?.setupRequired ?? false;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const status = setup
        ? await api.post('/api/auth/setup', { name, title, password })
        : await api.post('/api/auth/login', { password });
      queryClient.setQueryData(keys.auth, status);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hero-glow relative flex min-h-full items-center justify-center px-4 py-10">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <Card className="w-full max-w-md p-6 sm:p-8">
        <Logo />
        <h1 className="mt-6 text-xl font-semibold">{setup ? 'Configuração inicial' : 'Entrar'}</h1>
        <p className="mt-1 text-sm text-muted">
          {setup
            ? 'Crie seu acesso local ao Thinkflow. Os dados ficam só na sua máquina.'
            : 'Digite sua senha para acessar o dashboard.'}
        </p>
        <form onSubmit={(e) => void submit(e)} className="mt-6 flex flex-col gap-4">
          {setup && (
            <>
              <Field label="Seu nome" htmlFor="setup-name">
                <Input
                  id="setup-name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
              </Field>
              <Field label="Cargo (opcional)" htmlFor="setup-title">
                <Input
                  id="setup-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Analista de Sistemas"
                />
              </Field>
            </>
          )}
          <Field
            label="Senha"
            htmlFor="password"
            hint={setup ? 'Mínimo de 8 caracteres' : undefined}
            error={error}
          >
            <Input
              id="password"
              type="password"
              required
              minLength={setup ? 8 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={setup ? 'new-password' : 'current-password'}
            />
          </Field>
          <Button type="submit" loading={busy} size="lg">
            {setup ? 'Criar acesso' : 'Entrar'}
          </Button>
        </form>
      </Card>
    </div>
  );
}

export function ComingSoonPage({ title }: { title: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent-text">
        <Sparkles className="h-7 w-7" />
      </div>
      <h1 className="mt-4 text-2xl font-semibold">{title}</h1>
      <p className="mt-2 max-w-md text-muted">
        Esta ferramenta chega em breve ao Thinkflow. Enquanto isso, use o chat com suas conexões e
        servidores MCP.
      </p>
      <Link
        to="/"
        className="mt-6 inline-flex h-10 items-center rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
      >
        Ir para o chat
      </Link>
    </div>
  );
}

export function HelpPage() {
  const steps = [
    {
      title: '1. Cadastre conexões',
      body: 'Em Conexões, adicione chaves de providers gratuitos (OpenRouter, Groq, Mistral…). Várias chaves do mesmo provider são revezadas.',
    },
    {
      title: '2. Monte um combo',
      body: 'Um combo é uma lista ordenada de provider/modelo. Se o primeiro responder 429, cota esgotada ou erro 5xx, o Thinkflow tenta o próximo — e coloca a conexão que falhou em cooldown.',
    },
    {
      title: '3. Converse',
      body: 'No chat, escolha o combo como modelo. Ative MCP para dar ferramentas à IA. O modo Agente usa o Claude Code (Agent SDK) com os tokens passando pelo roteador.',
    },
    {
      title: '4. Use no Claude Code / VS Code',
      body: 'Em Configurações, crie uma API key e copie o bloco para ~/.claude/settings.json. Pedidos "sonnet/opus/haiku" são mapeados para os seus combos.',
    },
  ];
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
      <PageHeader title="Ajuda" description="Como o Thinkflow funciona em quatro passos." />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {steps.map((s) => (
          <Card key={s.title} className="p-5">
            <h2 className="font-semibold">{s.title}</h2>
            <p className="mt-2 text-sm text-muted">{s.body}</p>
          </Card>
        ))}
      </div>
      <Card className="mt-5 p-5 text-sm text-muted">
        <h2 className="font-semibold text-fg">Acompanhe o consumo em Uso</h2>
        <p className="mt-2">
          A página Uso mostra os tokens consumidos no mês, por provider, modelo e origem, com
          estimativas diária, semanal, mensal e anual. O contador zera sozinho todo dia 1º e você
          pode definir um orçamento mensal para ser avisado quando a projeção o ultrapassar.
        </p>
      </Card>
      <Card className="mt-5 p-5 text-sm text-muted">
        <h2 className="font-semibold text-fg">Retome conversas no Histórico</h2>
        <p className="mt-2">
          Toda conversa fica salva. Na página Histórico você busca por título ou conteúdo, filtra
          por modo, fixa as importantes, renomeia e exclui. Conversas longas são resumidas
          automaticamente para caber no contexto do modelo, e o botão Derivar numa resposta cria uma
          nova conversa a partir daquele ponto, com um resumo do que veio antes. Os limites ficam em
          Configurações → Histórico e contexto.
        </p>
      </Card>
      <Card className="mt-5 p-5 text-sm text-muted">
        <h2 className="font-semibold text-fg">Biblioteca de documentos</h2>
        <p className="mt-2">
          Envie PDFs, DOCX, Markdown/TXT e imagens na página Biblioteca e escolha a biblioteca no
          chat: o modelo busca os trechos relevantes e cita o documento e a página. Imagens e PDFs
          escaneados passam por OCR. Use "Ver texto" para conferir a extração e "Testar busca" para
          ver o que o modelo recebe. Modelos sem suporte a tools podem não consultar a biblioteca.
        </p>
        <p className="mt-2">
          O engine NotebookLM (experimental) envia os documentos para uma conta Google e faz o
          NotebookLM responder com citações; se ele falhar, o índice local assume. É um serviço não
          oficial e mais lento: use uma conta separada (configure na aba NotebookLM da Biblioteca).
        </p>
      </Card>
      <Card className="mt-5 p-5 text-sm text-muted">
        <h2 className="font-semibold text-fg">Relatórios e modelos</h2>
        <p className="mt-2">
          Em Relatórios, escolha um modelo (relatório técnico, resumo, PRD, protótipo ou o guia de
          cálculo de débitos do e-Cidade, como exemplo), preencha as informações e gere o documento
          em segundo plano: a IA pesquisa nos servidores MCP e na Biblioteca, escreve seção por
          seção e monta o HTML, com download em PDF (precisa do Chromium), Markdown e opção de
          adicionar à Biblioteca. Você também pode começar pelos cartões da tela inicial do chat: a
          IA faz as perguntas e gera o documento quando você confirmar, ou use "Gerar agora".
          Modelos embutidos são somente leitura (use Duplicar); crie os seus em Modelos, inclusive
          com o assistente "Importar de prompt" ou "Criar com IA". A pesquisa roda sem supervisão e
          pode chamar qualquer ferramenta dos servidores MCP do modelo. Se a cota do provider
          acabar, use Retomar.
        </p>
      </Card>
      <Card className="mt-5 p-5 text-sm text-muted">
        <h2 className="font-semibold text-fg">Testes e evidências</h2>
        <p className="mt-2">
          Em Testes, crie uma sessão com a URL inicial e escolha o modo ao iniciar: Gravar passos
          (cada clique, preenchimento e navegação vira um passo com print automático) ou Só prints
          (nada vira passo; Capturar ou Ctrl+Shift+S na janela cria um passo com o print). Uma
          janela do Chromium abre no computador onde o Thinkflow roda (não funciona no Docker). Em
          Passos, edite cada print com retângulos, setas, números e tarjas, e use Verificar para
          registrar o que deve aparecer na tela. Senhas e dados marcados como sigilosos nunca
          aparecem nos prints, no documento nem no script. Em Dados e replay, crie conjuntos com
          outros valores e reexecute o teste; na aba Documento, copie o passo a passo para o
          Word/Google Docs ou baixe o .zip e o script Playwright (.spec.ts).
        </p>
      </Card>
      <Card className="mt-5 p-5 text-sm text-muted">
        <h2 className="font-semibold text-fg">Armazenamento de documentos</h2>
        <p className="mt-2">
          Os HTML e PDF dos relatórios ficam na pasta local do servidor ou, se configurado, em um
          bucket MinIO/S3. Se o armazenamento cair, o relatório continua disponível e é enviado
          assim que ele voltar; downloads já armazenados podem falhar até lá. Veja o estado, teste a
          conexão e reenvie pendências em Configurações &gt; Armazenamento de documentos.
        </p>
      </Card>
      <Card className="mt-5 p-5 text-sm text-muted">
        <h2 className="font-semibold text-fg">Diagramas</h2>
        <p className="mt-2">
          Diagramas Mermaid vindos de qualquer modelo (ou do NotebookLM) são normalizados e
          desenhados no chat, mesmo sem a cerca de código. Se houver erro de sintaxe, o Thinkflow
          tenta um reparo automático uma vez (aparece como diagram-repair em Uso) e, se não der,
          mostra o código. Nos documentos gerados os diagramas entram como imagem vetorial.
        </p>
      </Card>
      <Card className="mt-5 p-5 text-sm text-muted">
        <h2 className="font-semibold text-fg">Erros comuns</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <strong className="text-fg">"Nenhuma conexão disponível"</strong>: todas as chaves do
            combo estão desativadas ou em cooldown. Veja Conexões → Atividade.
          </li>
          <li>
            <strong className="text-fg">Ferramentas não são chamadas</strong>: nem todo modelo
            gratuito suporta function calling. Prefira modelos com suporte a tools nos combos usados
            pelo Agente/Claude Code.
          </li>
          <li>
            <strong className="text-fg">MCP stdio não inicia</strong>: confira se o comando (npx,
            uvx, python) está no PATH da máquina onde o Thinkflow roda.
          </li>
        </ul>
      </Card>
    </div>
  );
}
