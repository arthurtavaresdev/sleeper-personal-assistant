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
pnpm cli trades [--team <nome>] [--notify]
pnpm cli injuries [--notify]
pnpm cli backtest --weeks 2-6     # erro do modelo vs baseline (média da temporada)
pnpm cli bot                      # daemon: envia mensagens e responde comandos
```

Sem `--notify` o resultado só aparece no terminal. No Telegram, o bot responde a `/lineup`, `/waivers`,
`/trades [time]` e `/injuries`, mas só no chat configurado.

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
