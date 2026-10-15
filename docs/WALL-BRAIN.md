# WALL Brain (Wall Bot)

O cérebro do WALL OS. Guarda memória e tarefas e recebe comandos pelo Telegram. Roda no mesmo Cloudflare Pages + D1 do WALL OS/Finance, por isso responde com o notebook fechado. Não é um app paralelo.

> Esta é a parte técnica e pública. O pacote de contexto pessoal (saldos, decisões de negócio, dados de conta) **não** vai para este repositório, que é público: fica com o titular e entra no app pela tela **Cérebro WALL → + Memória**, protegida por login.

## O que existe (implementado e testado localmente)

| Peça | Onde | Regra |
| --- | --- | --- |
| Memória | `brain_memory`, tela Cérebro WALL, `/nota` | Cada item tem tipo (fato, decisão, hipótese, pendência, evidência), origem e validade. |
| Tarefas | `brain_tasks`, tela Cérebro WALL, `/tarefa` | Estados: backlog, ready, running, blocked, review, done, failed, cancelled. **Concluir exige evidência.** |
| Executores | variável `BRAIN_EXECUTORS` | Hoje: **nenhum**. Uma tarefa de Claude Code, Codex ou criativos que for para "pronta" ou "em execução" vira **bloqueada**, com o motivo. Nunca há sucesso fictício. |
| Telegram | `POST /api/telegram/webhook` | Só aceita com o cabeçalho secreto do webhook, só do ID do proprietário e só em conversa privada. Recusa sem revelar dados. |
| Deduplicação | `brain_events` (`tg:<update_id>`) | Um reenvio do Telegram, inclusive depois de reiniciar o servidor, não repete a ação. |
| Propostas | `brain_proposals`, `/despesa`, `/receita` | Primeiro só propõem. `/confirmar CÓDIGO` grava **uma vez**, como lançamento **pendente**. O código depende do conteúdo exato e vence em 30 min. Proposta cancelada, vencida ou já usada não funciona de novo. |
| Finanças | `/financeiro` | Mostra o saldo **calculado**, com a data do saldo de referência. Lançamento contábil não movimenta dinheiro, e o pendente só entra no saldo quando o titular confirma no app, passando pela proteção da reserva. |
| Backup | `/api/backup` | Inclui as tabelas `brain_*`. |

O webhook responde ao Telegram **na própria resposta HTTP** (`method: sendMessage`). Por isso o servidor não precisa do token do bot. O token só é usado uma vez, pelo titular, para registrar o webhook.

### Comandos
`/status` · `/projetos` · `/tarefa texto #projeto @claude|@codex|@criativos` · `/nota texto` · `/financeiro` · `/despesa 12,50 descrição @conta` · `/receita 50 descrição @conta` · `/confirmar CÓDIGO` · `/cancelar CÓDIGO|T-XXXXX` · `/ajuda`

## Como ligar (custo €0, feito pelo titular)

1. **Criar o bot:** no Telegram, @BotFather → `/newbot`. O token fica só com você: nunca no chat, no GitHub ou no código.
2. **Descobrir seu ID:** pegue seu ID numérico de usuário (por exemplo, com @userinfobot).
3. **Cadastrar os segredos:** Cloudflare → Pages → `wall-finance` → Settings → Variables. Cadastre como **secret**:
   - `TELEGRAM_WEBHOOK_SECRET`: senha aleatória longa, só com A-Z, a-z, 0-9, `_` e `-`;
   - `TELEGRAM_OWNER_ID`: o seu ID.

   Depois faça um novo deploy (as migrações aplicam a `0003_wall_brain.sql`).
4. **Registrar o webhook:** uma vez, no navegador:
   `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<seu-endereço>/api/telegram/webhook&secret_token=<o mesmo segredo>`
5. **Testar com o notebook fechado:** mande `/status` pelo celular. Só considere "funcionando na nuvem" depois dessa resposta.

## Validação

Feita em `npm test` e `npm run test:e2e` (wrangler + D1 local + Chromium):

- [x] Sem segredo ou com segredo errado → 401. Outro usuário ou grupo → "Este bot é privado.", sem dados.
- [x] Reenvio do mesmo `update_id` não duplica tarefa nem lançamento, inclusive depois de reiniciar o servidor.
- [x] Agente sem executor → tarefa bloqueada com motivo.
- [x] Concluir sem evidência → recusado.
- [x] `/confirmar` repetido → recusado. Código de outra proposta → código diferente. Proposta cancelada → não confirma.
- [x] Dois `/confirmar` simultâneos → a gravação inteira é desfeita na segunda (`changes() = 0`; testado com SQLite em `tests/unit/revision-guard.test.mjs`, não no D1 real).
- [x] Migração 0003 aplicada sobre um banco com dados existentes, sem perdas.
- [x] Teste de privacidade: nenhum saldo pessoal ou token do Telegram nos arquivos versionados.

**Não verificado:**
- deploy em produção;
- bot real no Telegram;
- resposta com o notebook fechado;
- qualquer executor cloud (Claude Code ou Codex).

## Próximas fases (ordem do plano)
3. **Executor cloud real.** Exemplo: GitHub Actions disparado por tarefa, com fila, limites e retorno de evidência. Só ligar depois de confirmar custo €0 e autenticação. Até lá, as tarefas ficam bloqueadas.
4. **Finanças pelo Telegram.**
   - Recibo por foto vira proposta, com OCR feito no servidor ou no aparelho.
   - Hoje `/despesa` já cria a proposta e grava o lançamento pendente.
5. **Painel unificado e operação de ofertas.** O checkout de produção continua bloqueado até validar a identificação do vendedor e a política de reembolso.
