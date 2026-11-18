import {
  templateSpecSchema,
  type TemplateKind,
  type TemplateSpec,
  type TemplateSpecInput,
} from '@thinkflow/shared';

/**
 * Templates shipped with the app. They are read-only (users customize them with "Duplicar") and
 * are inserted/upgraded at boot: bump `builtInVersion` whenever the content of a seed changes.
 */
export interface BuiltinTemplate {
  id: string;
  name: string;
  kind: TemplateKind;
  description: string;
  builtInVersion: number;
  spec: TemplateSpec;
}

const define = (
  t: Omit<BuiltinTemplate, 'spec'> & { spec: TemplateSpecInput },
): BuiltinTemplate => ({ ...t, spec: templateSpecSchema.parse(t.spec) });

const LIMITS_RULE =
  'Quando algo não for encontrado nas fontes, diga isso explicitamente e inclua o item em "Itens não resolvidos". Nunca invente nomes de tabelas, campos, funções ou valores.';

const GENERIC_RULES = [
  'Use somente fatos presentes nas fontes consultadas; aponte a origem quando for relevante.',
  LIMITS_RULE,
  'Prefira listas e tabelas curtas a parágrafos longos.',
];

export const REPORT_TECNICO_ID = 'builtin-report-tecnico';
export const SUMMARY_ID = 'builtin-summary';
export const PRD_ID = 'builtin-prd';
export const PROTOTYPE_ID = 'builtin-prototype';
export const ECIDADE_FC_CALCULA_ID = 'builtin-ecidade-fc-calcula';

const reportTecnico = define({
  id: REPORT_TECNICO_ID,
  name: 'Análise técnica (genérico)',
  kind: 'report',
  description:
    'Relatório técnico de uso geral: resumo, contexto, funcionamento, detalhamento, riscos e próximos passos.',
  builtInVersion: 1,
  spec: {
    persona: 'Analista de sistemas sênior, didático e rigoroso com as fontes.',
    objective:
      'Produzir uma análise técnica sobre {{assunto}}, pesquisando nas fontes disponíveis, para que {{publico}} entendam o assunto sem precisar ler o código ou os documentos originais.',
    audience: '{{publico}}',
    titlePattern: 'Análise técnica: {{assunto}}',
    research: {
      useMcp: true,
      mcpServers: [],
      useLibrary: true,
      directives: [
        'Localize as definições, regras e fluxos relacionados a {{assunto}}.',
        'Levante entradas, saídas, dados envolvidos e integrações.',
        'Identifique pontos de atenção, exceções e dependências.',
      ],
      maxSteps: 6,
    },
    sections: [
      {
        id: 'resumo',
        title: 'Resumo executivo',
        requirements:
          'Em até 6 linhas: o que é {{assunto}}, por que importa e as principais conclusões. Se houver números, apresente uma tabela curta de métricas.',
        table: 'optional',
        maxWords: 250,
      },
      {
        id: 'contexto',
        title: 'Contexto e escopo',
        requirements:
          'Onde {{assunto}} se encaixa no sistema ou processo, o que está dentro e fora do escopo desta análise e quais fontes foram consultadas.',
      },
      {
        id: 'funcionamento',
        title: 'Como funciona',
        requirements:
          'Explique o funcionamento passo a passo, em linguagem acessível. Se ajudar, inclua um diagrama Mermaid do fluxo principal.',
        diagram: 'optional',
      },
      {
        id: 'detalhamento',
        title: 'Detalhamento',
        requirements:
          'Aprofunde as regras, os cálculos e as condições relevantes, citando a fonte (arquivo, função, documento) de cada afirmação importante.',
      },
      {
        id: 'dados',
        title: 'Dados, tabelas e integrações',
        requirements:
          'Liste os dados lidos e gravados e as integrações com outros módulos ou sistemas, em tabela quando houver mais de três itens.',
        table: 'optional',
      },
      {
        id: 'riscos',
        title: 'Riscos e pontos de atenção',
        requirements:
          'Riscos, exceções, casos de borda e armadilhas conhecidas, do mais para o menos relevante.',
      },
      {
        id: 'recomendacoes',
        title: 'Recomendações e próximos passos',
        requirements: 'Ações concretas e priorizadas, com o motivo de cada uma.',
      },
      {
        id: 'limites',
        title: 'Itens não resolvidos e limites',
        requirements:
          'O que não foi encontrado nas fontes, o que foi assumido e o que exige confirmação humana.',
      },
    ],
    style: {
      tone: 'Analítico, claro e direto.',
      rules: GENERIC_RULES,
    },
    variables: [
      {
        name: 'assunto',
        label: 'Assunto',
        description: 'Tema, módulo, função ou processo a ser analisado.',
        required: true,
        example: 'Rotina de cálculo de juros e multa',
      },
      {
        name: 'publico',
        label: 'Público',
        description: 'Quem vai ler o documento.',
        defaultValue: 'analistas',
        example: 'analistas',
      },
    ],
    intakeQuestions: [
      'Qual é o assunto exato da análise?',
      'Para quem é o documento (nível técnico do leitor)?',
      'Há alguma fonte, módulo ou documento que deve ser priorizado?',
    ],
    layout: { theme: 'thinkflow' },
  },
});

const summary = define({
  id: SUMMARY_ID,
  name: 'Resumo de documento técnico',
  kind: 'summary',
  description:
    'Resumo objetivo de um documento ou material técnico, com decisões, riscos e próximos passos.',
  builtInVersion: 1,
  spec: {
    persona: 'Analista que sintetiza material técnico com fidelidade ao original.',
    objective:
      'Resumir {{documento}} de forma que o leitor entenda o essencial em poucos minutos, sem perder decisões, riscos e pendências.',
    audience: 'Leitores com pouco tempo, técnicos ou não.',
    titlePattern: 'Resumo: {{documento}}',
    research: {
      useMcp: false,
      mcpServers: [],
      useLibrary: true,
      directives: [
        'Leia o material de {{documento}} por completo antes de resumir.',
        'Registre decisões, números, prazos e responsáveis citados.',
      ],
      maxSteps: 4,
    },
    sections: [
      {
        id: 'objetivo',
        title: 'Objetivo',
        requirements: 'Para que o material existe e a quem se destina, em até 4 linhas.',
        maxWords: 120,
      },
      {
        id: 'pontos',
        title: 'Principais pontos',
        requirements: 'Lista com os pontos mais importantes, na ordem de relevância.',
        maxWords: 350,
      },
      {
        id: 'decisoes',
        title: 'Decisões',
        requirements: 'Decisões tomadas ou propostas, com o motivo. Se não houver, diga isso.',
        maxWords: 250,
      },
      {
        id: 'riscos',
        title: 'Riscos',
        requirements: 'Riscos, dependências e pontos em aberto mencionados no material.',
        maxWords: 250,
      },
      {
        id: 'proximos',
        title: 'Próximos passos',
        requirements: 'Ações seguintes, com responsável e prazo quando houver.',
        maxWords: 200,
      },
      {
        id: 'glossario',
        title: 'Glossário',
        requirements: 'Termos técnicos ou siglas do material, em tabela de duas colunas.',
        table: 'optional',
        maxWords: 200,
      },
    ],
    style: {
      tone: 'Objetivo e conciso.',
      rules: [
        'Resuma sem acrescentar opiniões ou informações que não estejam no material.',
        LIMITS_RULE,
      ],
    },
    variables: [
      {
        name: 'documento',
        label: 'Documento',
        description: 'Nome ou descrição do material a resumir.',
        defaultValue: 'o material anexado ou da biblioteca',
        example: 'Especificação do módulo de arrecadação',
      },
    ],
    intakeQuestions: [
      'Qual documento deve ser resumido?',
      'Há algum aspecto que deve ter destaque?',
    ],
    layout: { theme: 'compacto', cover: false },
  },
});

const prd = define({
  id: PRD_ID,
  name: 'PRD de funcionalidade',
  kind: 'prd',
  description:
    'Documento de requisitos de produto para uma funcionalidade: problema, objetivos, requisitos e fluxo.',
  builtInVersion: 1,
  spec: {
    persona: 'Gerente de produto experiente, que escreve requisitos testáveis.',
    objective:
      'Escrever o PRD da funcionalidade {{funcionalidade}}, deixando claros o problema, os objetivos mensuráveis, os requisitos e o que fica de fora.',
    audience: 'Time de produto, design e desenvolvimento.',
    titlePattern: 'PRD: {{funcionalidade}}',
    research: {
      useMcp: false,
      mcpServers: [],
      useLibrary: true,
      directives: [
        'Procure nas fontes o contexto atual de {{funcionalidade}}: processos, regras e telas existentes.',
        'Levante restrições técnicas e dependências conhecidas.',
      ],
      maxSteps: 5,
    },
    sections: [
      {
        id: 'problema',
        title: 'Problema',
        requirements:
          'Qual problema {{funcionalidade}} resolve, para quem e qual a evidência dele.',
      },
      {
        id: 'objetivos',
        title: 'Objetivos e métricas',
        requirements: 'Objetivos mensuráveis e como o sucesso será medido.',
        table: 'optional',
      },
      {
        id: 'personas',
        title: 'Personas',
        requirements: 'Quem usa a funcionalidade e o que cada perfil precisa fazer.',
      },
      {
        id: 'funcionais',
        title: 'Requisitos funcionais',
        requirements:
          'Tabela com identificador (RF-01…), descrição, prioridade e critério de aceite de cada requisito.',
        table: 'required',
      },
      {
        id: 'nao-funcionais',
        title: 'Requisitos não funcionais',
        requirements: 'Desempenho, segurança, acessibilidade, auditoria e compatibilidade.',
      },
      {
        id: 'fluxo',
        title: 'Fluxo do usuário',
        requirements: 'Fluxo principal e alternativos, com um diagrama Mermaid.',
        diagram: 'required',
      },
      {
        id: 'riscos',
        title: 'Riscos e dependências',
        requirements: 'O que pode dar errado e o que precisa estar pronto antes.',
      },
      {
        id: 'fora-escopo',
        title: 'Fora de escopo',
        requirements: 'O que explicitamente não será entregue nesta versão.',
      },
      {
        id: 'questoes',
        title: 'Questões em aberto',
        requirements: 'Perguntas que ainda precisam de resposta, com o responsável sugerido.',
      },
    ],
    style: {
      tone: 'Claro, preciso e orientado a decisão.',
      rules: ['Escreva requisitos testáveis, um por linha.', LIMITS_RULE],
    },
    variables: [
      {
        name: 'funcionalidade',
        label: 'Funcionalidade',
        description: 'Nome da funcionalidade ou do problema a documentar.',
        required: true,
        example: 'Emissão de segunda via de guia',
      },
    ],
    intakeQuestions: [
      'Qual funcionalidade será documentada?',
      'Quem são os usuários principais?',
      'Existe prazo, restrição ou dependência importante?',
    ],
    layout: { theme: 'thinkflow' },
  },
});

const prototype = define({
  id: PROTOTYPE_ID,
  name: 'Protótipo de interface',
  kind: 'prototype',
  description:
    'Protótipo navegável (HTML sem JavaScript) com visão geral, mapa de navegação, componentes e telas.',
  builtInVersion: 1,
  spec: {
    persona:
      'Designer de produto que descreve interfaces com clareza e usa um kit de componentes fixo.',
    objective:
      'Descrever e prototipar a interface de {{produto}}: visão geral, mapa de navegação, componentes, estados e as telas pedidas.',
    audience: 'Time de produto, design e desenvolvimento.',
    titlePattern: 'Protótipo: {{produto}}',
    research: {
      useMcp: false,
      mcpServers: [],
      useLibrary: true,
      directives: [
        'Levante as telas, campos e fluxos que {{produto}} precisa ter.',
        'Procure padrões de interface e regras de negócio nas fontes.',
      ],
      maxSteps: 4,
    },
    sections: [
      {
        id: 'visao',
        title: 'Visão geral',
        requirements: 'Objetivo da interface, usuários e principais tarefas.',
      },
      {
        id: 'navegacao',
        title: 'Mapa de navegação',
        requirements: 'Como o usuário se move entre as telas, com um diagrama Mermaid.',
        diagram: 'required',
      },
      {
        id: 'componentes',
        title: 'Componentes',
        requirements:
          'Componentes reutilizados (formulários, tabelas, botões, avisos) e o papel de cada um.',
      },
      {
        id: 'estados',
        title: 'Estados e mensagens',
        requirements:
          'Estados vazios, de carregamento, de erro e de sucesso, com os textos exibidos.',
      },
    ],
    style: {
      tone: 'Objetivo e visual.',
      rules: ['Use português do Brasil em todos os textos de interface.', LIMITS_RULE],
    },
    variables: [
      {
        name: 'produto',
        label: 'Produto ou tela',
        description: 'O que será prototipado.',
        required: true,
        example: 'Painel de acompanhamento de débitos',
      },
      {
        name: 'telas',
        label: 'Telas desejadas',
        description: 'Lista opcional das telas que o protótipo deve ter.',
        example: 'Listagem, detalhe, formulário de edição',
      },
    ],
    intakeQuestions: [
      'O que será prototipado?',
      'Quais telas são indispensáveis?',
      'Há alguma referência visual ou regra de negócio importante?',
    ],
    layout: { theme: 'thinkflow', cover: false },
  },
});

const ecidade = define({
  id: ECIDADE_FC_CALCULA_ID,
  name: 'Guia do Analista — cálculo de débitos (e-Cidade)',
  kind: 'report',
  description:
    'Guia para analistas não desenvolvedores sobre como uma função PL/pgSQL do e-Cidade (padrão: fc_calcula) calcula correção, juros, multa e desconto de um débito.',
  builtInVersion: 1,
  spec: {
    persona:
      'Arquiteto de Sistemas Especialista no e-Cidade. Consulta o servidor MCP do e-Cidade (mapa estático e determinístico do código e do banco) como fonte principal.',
    objective:
      'Explicar, para analistas que não são desenvolvedores, como o sistema calcula correção, juros, multa e desconto de um débito por meio da função {{funcao}}, de modo que consigam validar resultados e atender chamados sem ler o código.',
    audience: 'Analistas de sistemas e de negócio que não são desenvolvedores.',
    titlePattern:
      'Guia do Analista: como o sistema calcula correção, juros, multa e desconto de um débito ({{funcao}})',
    research: {
      useMcp: true,
      mcpServers: [],
      useLibrary: true,
      directives: [
        'Obtenha o código-fonte, os parâmetros e os retornos da função {{funcao}}.',
        'Liste as funções auxiliares chamadas por {{funcao}} e o que cada uma faz.',
        'Levante as tabelas e os campos lidos e gravados e relacione cada tabela ao caminho de menu do e-Cidade onde o dado é cadastrado ou consultado.',
        'Encontre os pontos de entrada (PHP, API, menus) que chamam {{funcao}}.',
        'Extraia as regras matemáticas (correção, juros, multa, desconto) com as linhas do código-fonte que as implementam.',
      ],
      maxSteps: 8,
    },
    sections: [
      {
        id: 'resumo',
        title: 'Resumo',
        requirements:
          'Em linguagem simples, o que {{funcao}} faz e em que situações é usada. Inclua uma tabela de métricas com: número de parâmetros, funções auxiliares, tabelas lidas, tabelas gravadas e códigos de retorno.',
        table: 'required',
        maxWords: 300,
      },
      {
        id: 'entradas-saidas',
        title: 'Entradas e saídas',
        requirements:
          'Duas tabelas: (1) parâmetros de entrada, com nome, tipo, significado para o negócio e exemplo; (2) o que a função devolve ou grava, com nome, tipo e significado.',
        table: 'required',
      },
      {
        id: 'fluxo',
        title: 'Fluxo',
        requirements:
          'Diagrama Mermaid (flowchart) com as decisões e os passos principais de {{funcao}}, do recebimento dos parâmetros até a gravação e o retorno. Inclua uma frase de legenda.',
        diagram: 'required',
      },
      {
        id: 'passo-a-passo',
        title: 'Passo a passo',
        requirements:
          'Lista numerada explicando cada etapa do fluxo em linguagem de negócio, na ordem em que acontece, citando o nome técnico entre parênteses.',
      },
      {
        id: 'formulas',
        title: 'Fórmulas',
        requirements:
          'As fórmulas de correção, juros, multa e desconto, uma por subtítulo, com a expressão matemática, o significado de cada termo e a referência às linhas do código-fonte (arquivo:linha).',
      },
      {
        id: 'exemplo-numerico',
        title: 'Exemplo numérico',
        requirements:
          'Um exemplo completo com valores fictícios e coerentes com as fórmulas, em tabela com os passos do cálculo e o resultado de cada um. Indique que os valores são ilustrativos.',
        table: 'required',
      },
      {
        id: 'funcoes-auxiliares',
        title: 'Funções auxiliares',
        requirements:
          'Tabela com o nome de cada função auxiliar chamada, o que ela faz para o negócio e onde é usada no fluxo.',
        table: 'required',
      },
      {
        id: 'tabelas-menus',
        title: 'Tabelas, campos e menus',
        requirements:
          'Duas tabelas: (1) tabelas e campos lidos/gravados, com o papel de cada um; (2) o caminho de menu do e-Cidade (Módulo > Menu > Procedimento) para cadastrar ou consultar cada dado. Se um caminho de menu não for encontrado nas fontes, escreva "não localizado".',
        table: 'required',
      },
      {
        id: 'gravacao-retornos',
        title: 'Gravação e códigos de retorno',
        requirements:
          'O que é gravado na tabela debitos (campos e quando) e a tabela dos códigos de retorno de 0 a 9, com o significado de cada um e a causa provável.',
        table: 'required',
      },
      {
        id: 'quem-chama',
        title: 'Quem chama',
        requirements:
          'Os pontos de entrada que chamam {{funcao}}: arquivos PHP, rotas de API e menus, agrupados por módulo, com uma frase sobre o motivo da chamada.',
      },
      {
        id: 'atencao-validacao',
        title: 'Pontos de atenção e roteiro de validação',
        requirements:
          'Armadilhas e exceções que causam divergência de valores. Depois, um roteiro de validação em tabela (passo, o que conferir, onde conferir, resultado esperado) para o analista reproduzir o cálculo. Termine com a lista de itens não resolvidos.',
        table: 'required',
      },
      {
        id: 'glossario-limites',
        title: 'Glossário e limites',
        requirements:
          'Glossário dos termos técnicos e siglas usados (tabela de duas colunas) e os limites deste guia: o que não foi encontrado nas fontes e o que exige confirmação com um desenvolvedor.',
        table: 'optional',
      },
    ],
    style: {
      tone: 'Analítico e direto.',
      rules: [
        'Escreva para analistas que não são desenvolvedores: explique termos técnicos na primeira vez em que aparecerem.',
        LIMITS_RULE,
        'Sempre que citar uma regra ou fórmula, indique a origem no código (arquivo e linha) quando disponível.',
        'Use somente nomes de tabelas, campos e funções que apareceram nas fontes consultadas.',
      ],
    },
    variables: [
      {
        name: 'funcao',
        label: 'Função PL/pgSQL',
        description: 'Nome da função do banco de dados do e-Cidade a ser explicada.',
        required: true,
        defaultValue: 'fc_calcula',
        example: 'fc_calcula',
      },
    ],
    intakeQuestions: [
      'Qual função do e-Cidade deve ser explicada (padrão: fc_calcula)?',
      'Há algum tipo de débito ou cenário que deve ter destaque (IPTU, ISSQN, taxas)?',
      'O leitor precisa de um roteiro de validação para algum caso específico?',
    ],
    layout: {
      theme: 'sobrio',
      primaryColor: '#1d4ed8',
      accentColor: '#60a5fa',
      coverSubtitle: 'Guia do Analista · e-Cidade',
      headerText: 'Guia do Analista — e-Cidade',
      footerText: 'Gerado pelo Thinkflow',
    },
  },
});

export const BUILTIN_TEMPLATES: readonly BuiltinTemplate[] = [
  reportTecnico,
  summary,
  prd,
  prototype,
  ecidade,
];
