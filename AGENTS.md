# Orientações para agentes

## Projeto e comunicação

Sleeper Personal Assistant é um assistente pessoal de fantasy NFL em TypeScript/Node, com CLI, PostgreSQL e bot do Telegram. Responda ao usuário em português e mantenha mensagens do produto em português. Consulte o README e o código antes de alterar comportamentos. Faça commits ao concluir etapas coerentes; não faça push sem solicitação. Preserve alterações existentes do usuário.

## Stack e comandos

- Node >=22, pnpm, TypeScript ESM com imports locais terminados em `.js`; execução via `tsx`.
- `pnpm install`: instala dependências.
- `pnpm db:up`: PostgreSQL 17 via Podman Compose, porta local 5433.
- `pnpm migrate up`: aplica migrations SQL versionadas.
- `pnpm typecheck` e `pnpm test`: validações para mudanças de código.
- `pnpm cli --help`: comandos disponíveis. Análises sem `--notify` imprimem no terminal.
- Não exija banco, rede ou tokens para testes unitários; use fixtures e mocks.
- Para documentação apenas, revise o diff; não é necessário rodar toda a suíte.

## Organização

- `src/sleeper/`: API pública e GraphQL autenticado opcional, com schemas Zod.
- `src/data/`: ingestão Sleeper/nflverse e mapeamento de IDs.
- `src/db/` e `migrations/`: acesso ao Postgres, schemas, funções e materialized views.
- `src/model/`: insumos, projeções próprias, pontuação e projeções do restante da temporada.
- `src/optimizer/`: lineup guloso/ILP e travas após kickoff.
- `src/analysis/`: lineup, waivers, claims, trocas e valoração de rosters.
- `src/jobs/`: orquestração, sincronização, setup e daemon do bot.
- `src/notify/`: Telegram, formatação HTML, outbox e confirmações de conexão.
- `deploy/`: Compose, instalador e templates de units/timers do systemd.

## Regras de domínio

- Use configurações reais da liga: pontuação, slots, FAAB, prioridade de waiver e tipo redraft/keeper/dynasty. Não use projeções do Sleeper como projeções próprias.
- Considere temporada, semana, bye, lesão e elegibilidade. Jogadores sem jogo na semana têm projeção zero; respeite titulares travados e reservas cujo jogo já começou.
- Normalize diferenças de siglas entre fontes, como LA/LAR, e mapeie IDs explicitamente. Não adivinhe IDs por nome.
- Waivers e trocas medem o ganho no lineup ótimo semana a semana, não apenas a soma de pontos individuais.
- Preferência posicional definida pelo usuário: **RB > WR > TE > QB > K > DEF**. Valor de negociação considera excedente sobre reposição nos waivers e os fatores documentados no código. Pontos projetados não são alterados por esses fatores. O desconto de QB de 1QB não se aplica a 2QB/superflex.
- Preserve o equilíbrio de valor para ambos os lados nas trocas; K e DEF não entram nas sugestões automáticas atuais. Dynasty também considera idade.
- Claims autenticadas consultam somente o roster do usuário. Lances pendentes de terceiros não são fonte da análise; concorrência é estimada por roster, FAAB e histórico processado. Apresente estimativas como estimativas.
- O aplicativo recomenda ações; não executa trocas, lances ou mudanças de lineup no Sleeper.

## Várias ligas

- `LEAGUE_IDS` seleciona IDs separados por vírgula; `auto` descobre todas as ligas NFL da temporada. `LEAGUE_ID` é o fallback legado. Preserve IDs como strings.
- A seleção operacional atual inclui Bandejeiros da NFL e Liga Dinastia NFL; a configuração fica no `.env`, não em constantes de código.
- Passe `leagueId` explicitamente pelo sync e contexto. Não altere configuração global para alternar entre ligas.
- Separe pontuação, rosters, FAAB, projeções, deduplicação e histórico de lesões por liga. Identifique relatórios pelo nome da liga.
- Uma falha de análise em uma liga não deve impedir as demais. Teste seleção, isolamento e continuidade em falhas ao mudar a orquestração.

## Postgres e integrações

- Prefira recursos do Postgres para persistência e agregações: JSONB, COPY, SQL, materialized views, índices, advisory locks e LISTEN/NOTIFY. Não adicione SQLite.
- Crie novas migrations para bancos já instalados; não reescreva migrations aplicadas nem recrie schemas com dados do usuário.
- Preserve a ordem de refresh das views e respeite TTLs das fontes. Calendário e linhas de Vegas vêm do release do nflverse.
- Use queries parametrizadas. Valide identificadores antes de qualquer interpolação SQL/GraphQL.
- API GraphQL interna é opcional e pode mudar: falhas devem ser tratadas sem derrubar análises públicas independentes.

## Telegram e operação

- Nunca versione ou exponha `.env`, tokens, cookies ou headers de autorização. Documente somente nomes das variáveis no `.env.example`; não imprima segredos em logs ou diagnósticos.
- O bot só atende o `TELEGRAM_CHAT_ID` configurado. Valide token/chat antes de iniciar e mantenha a trava que impede duas instâncias de long polling.
- O serviço systemd é a instância operacional. Não execute `pnpm cli bot` simultaneamente ao serviço.
- Envie confirmação de conexão no início e após recuperação de falha, uma vez por transição; não a cada poll bem-sucedido.
- Preserve outbox, deduplicação e locks de envio. Escape dados externos em HTML e respeite limites de mensagem do Telegram.
- Operação usa `America/Sao_Paulo`; considere jogos internacionais e kickoff ao ajustar horários.
- Após mudanças de código/configuração do daemon, reinicie `systemctl --user restart sleeper-personal-assistant-bot.service` quando fizer parte da tarefa autorizada. A reinicialização envia uma confirmação ao usuário.
- Diagnóstico: `systemctl --user status sleeper-personal-assistant-bot.service`, `journalctl --user -u sleeper-personal-assistant-bot.service` e `systemctl --user list-timers 'sleeper-personal-assistant-*'`.
- Diferencie validação unitária de execução real. Não afirme que mensagens foram entregues ou ligas sincronizadas sem evidência da execução correspondente.
