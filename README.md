# Sleeper Trader

Assistente pessoal para ligas de NFL no [Sleeper](https://sleeper.com): lê as configurações da sua liga,
gera **projeções próprias** a partir de dados públicos do [nflverse](https://github.com/nflverse/nflverse-data)
(as projeções do Sleeper não são usadas) e manda no Telegram:

- **Lineup ótimo da semana**, respeitando slots da liga (FLEX, SUPER_FLEX…) e jogadores travados após o kickoff;
- **Waivers**: o par adicionar/largar que mais melhora seu lineup no restante da temporada, com lance FAAB sugerido;
- **Trocas** 1x1, 2x1 e 1x2 que melhoram o seu time *sem piorar* o do parceiro (mais chance de aceite);
- **Alertas de lesão** dos seus jogadores, só quando o status muda.

A API do Sleeper é somente leitura: o app sugere, você aplica no app do Sleeper.

## Requisitos

- Node 22+ e pnpm
- Podman (ou Docker) para o PostgreSQL 17
- Um bot do Telegram (crie com o [@BotFather](https://t.me/BotFather))

## Instalação

```bash
pnpm install
cp .env.example .env
pnpm db:up                 # Postgres em localhost:5433 (inclui o banco sleeper_test)
pnpm migrate up
pnpm cli setup             # usuário do Sleeper, liga e bot do Telegram
pnpm cli sync              # primeira carga (~1 min)
```

No `setup`, cole o token do BotFather, mande `/start` para o seu bot e aperte Enter: o `chat_id` é
descoberto sozinho e uma mensagem de teste é enviada.

> Com Podman, o `compose` precisa do socket de usuário: `systemctl --user enable --now podman.socket`.

## Uso

```bash
pnpm cli lineup [--week N] [--notify]
pnpm cli waivers [--notify]
pnpm cli claims [--notify]         # avalia seus lances de waiver pendentes
pnpm cli trades [--team <nome>] [--notify]
pnpm cli inbox [--league-id ID] [--notify]  # propostas de trade recebidas
pnpm cli injuries [--notify]
pnpm cli backtest --weeks 2-6     # erro do modelo vs baseline (média da temporada)
pnpm cli bot                      # daemon: envia mensagens e responde comandos
```

Sem `--notify` o resultado só aparece no terminal. No Telegram, o bot responde a `/lineup`, `/waivers`,
`/claims`, `/trades [time]`, `/inbox` e `/injuries`, mas só no chat configurado.
Os comandos analisam todas as ligas configuradas; use `--league-id ID` no terminal para selecionar uma.
`claims` e `inbox` exigem `SLEEPER_TOKEN` configurado.

## Agendamento (systemd)

```bash
deploy/install-systemd.sh
```

Instala units de usuário apontando para este diretório e para o Node atual (funciona com nvm), habilita
`linger` (roda sem sessão aberta) e o `podman-restart` (o Postgres volta após reboot). Horários de Brasília:

| Timer | Quando |
|---|---|
| waivers | terça 10:00 (antes do processamento de quarta) |
| trades | quarta 12:00 |
| lineup | quinta 15:00 (antes do TNF) e domingo 09:00 (antes do jogo de Londres/1º jogo) |
| injuries | quinta a domingo, a cada 2h entre 08:00 e 22:00 |

`Persistent=true` executa na próxima inicialização o que foi perdido com o PC desligado.
Acompanhe com `systemctl --user list-timers 'sleeper-trader-*'` e `journalctl --user -u 'sleeper-trader*'`.

## Como funciona

```
Sleeper API ─┐                    ┌─ model.player_usage ─┐
nflverse ────┼─ COPY → raw.* ─→ core.* ─┤                      ├─ *_form_mv (EWMA) ─→ TS: projeção → otimizador → análises
DynastyProcess IDs ┘                    └─ model.team_usage ───┘   defense_vs_pos_mv          │
                                                                                           app.outbox ─(pg_notify)→ Telegram
```

- **PostgreSQL faz o trabalho pesado**: CSVs entram via `COPY FROM STDIN`; stats ficam em `jsonb`; uso por
  jogo, EWMA (peso 0,8ⁿ, temporada anterior a 60%) e pontos cedidos por defesa são materialized views
  atualizadas com `REFRESH ... CONCURRENTLY`; a pontuação da liga é a função SQL `model.fantasy_points`.
- **Projeção** (`src/model/projection.ts`): volume do time (total implícito de Vegas + game script) ×
  participação do jogador (targets/carries/passes, com *shrinkage* para o papel na depth chart) × eficiência
  regredida à média da posição × matchup × disponibilidade (status de lesão). Gera média, desvio, piso (p20) e teto (p80).
- **Lineup**: o guloso é exato para flex aninhados e jogadores de uma posição; caso contrário, ILP.
- **Waivers e trocas** medem o ganho no **lineup ótimo semana a semana** até a semana 17, o que já
  considera byes e profundidade do banco.
- **Mensagens** passam por um outbox com dedupe (a mesma sugestão não é reenviada) e `FOR UPDATE SKIP LOCKED`.
  Jobs usam `pg_advisory_lock` para nunca rodarem em paralelo.

### Precisão (backtest 2026, semanas 2–6, half-PPR)

| Posição | MAE modelo | MAE baseline |
|---|---|---|
| QB | 5,94 | 7,28 |
| RB | 3,99 | 4,44 |
| WR | 3,91 | 4,27 |
| TE | 3,27 | 3,82 |
| K | 3,98 | 4,45 |
| DEF | 3,86 | 4,85 |

## Limitações conhecidas

- QBs têm viés de ~−1,9 pt (o ambiente de passe de 2026 está acima do de 2025). Calibrar pesos e priors por
  regressão sobre várias temporadas é o próximo passo natural.
- Participação liberada por lesão de um companheiro não é redistribuída automaticamente; o *role trend*
  de snaps capta isso só depois de 1–2 jogos.
- Slots IDP não são modelados.
- No backtest, a depth chart usada é a atual (leve vazamento).

## Desenvolvimento

```bash
pnpm test          # vitest
pnpm typecheck
```

### Valor posicional nas trocas

O valor de negociação usa o excedente projetado no restante da temporada sobre o melhor free agent da posição, ponderado pela preferência de mercado da liga: **RB > WR > TE > QB > K > DEF**. Os fatores heurísticos são, respectivamente, 1,25 / 1,10 / 1,00 / 0,80 / 0,50 / 0,40. Eles não alteram pontos projetados. Assim, um QB com muitos pontos pode ter pouco valor de troca quando há substitutos próximos nos waivers. O desconto de QB não se aplica em 2QB ou superflex.

As sugestões exigem equilíbrio de valor para os dois lados (diferença máxima de 20%), além do ganho de lineup. K e DEF continuam fora das sugestões automáticas. Em dynasty, aplica-se também a curva de idade. Esses fatores representam uma preferência da liga, não preços medidos de mercado.

### Acompanhar várias ligas

Configure `LEAGUE_IDS=1389707052531601408,OUTRO_ID` no `.env`. Sem essa variável, `LEAGUE_ID` continua funcionando. `LEAGUE_IDS=auto` acompanha todas as ligas NFL da temporada atual do usuário. O `setup` permite selecionar várias ligas por número, separadas por vírgula.

Os comandos `lineup`, `waivers`, `claims`, `trades`, `inbox`, `injuries` e os mesmos comandos no Telegram processam todas as ligas configuradas. Os timers existentes também passam a acompanhar todas elas, com mensagens identificadas pelo nome da liga e deduplicação independente. Cada liga usa sua própria pontuação, roster, FAAB e waivers. Uma falha em uma liga não interrompe as demais.

Para analisar uma liga específica no terminal: `pnpm cli lineup --league-id ID` (a opção também existe nos outros comandos de análise e no `sync`). Depois de mudar a configuração, reinicie o bot com `systemctl --user restart sleeper-trader-bot.service`. Aplique `pnpm migrate up` antes de usar o acompanhamento de lesões por liga.

### Inbox de trades

`pnpm cli inbox` ou `/inbox` no Telegram consulta propostas recebidas ainda em status `proposed`, envolvendo seu roster e sem o seu aceite. Exige `SLEEPER_TOKEN`. Para uma liga específica, use `--league-id ID`; `--notify` envia o relatório ao Telegram.

O relatório mostra jogadores, picks e FAAB enviados/recebidos, impacto no lineup desta semana e do restante da temporada, valor posicional dos jogadores e ganho dos parceiros. Pode sugerir uma alternativa com o mesmo parceiro e algum dos jogadores desejados. Nenhuma operação de aceite, rejeição ou envio é executada.

Picks e FAAB são exibidos separadamente, sem conversão inventada para pontos. Propostas com esses ativos, jogadores sem projeção, vagas excedentes ou IR/taxi exigem revisão manual. Na dynasty, o relatório também sinaliza que o modelo atual considera idade e o restante desta temporada, não o valor completo de carreiras futuras.

O timer `sleeper-trader-inbox.timer` verifica as duas ligas a cada 15 minutos, usando `inbox --notify --new-only`. Só propostas novas ou alteradas geram alertas; inbox vazio fica silencioso e mudanças nas projeções não reenviam a mesma oferta. A deduplicação fica no outbox do Postgres e sobrevive a reinicializações. O instalador `deploy/install-systemd.sh` inclui esse timer.
