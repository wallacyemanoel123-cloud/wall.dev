# Diagnóstico técnico (outubro de 2026)

Auditoria feita antes da v1.0. O piloto original foi **preservado sem alterações** no repositório privado `wall` (pasta `pilot-delivery/`).

## Piloto existente

- **Stack**: JavaScript puro (sem framework), servidor Node local (`painel/server.mjs`), Worker no Cloudflare Pages em modo avançado (`cloud/worker.mjs`, gerado por `cloud/build.mjs`) e Cloudflare D1.
- **Persistência**: D1, porém com **um único documento JSON** (`wall_state`), revisão global e limite de 4 MB. Sem consultas por registro.
- **Funcionando**: login por chave com sessão em cookie, lançamentos manuais em EUR, metas, planos, diário, checklist, calendário, investimentos, orçamento diário, auditoria, exportação JSON, PWA básico.
- **Simulado**: “equipe” de 8 agentes de IA que apenas salvam mensagens (sem respostas).
- **Ausente**: contas independentes, transferências, reserva protegida, conciliação, anexos/recibos, recorrências, delivery como módulo, BRL, CSV, relatórios com gráficos, edição/exclusão de lançamentos.
- **PWA incompleto**: só ícone 192 px (Android/Chrome exige 512 px).

## Autenticação da IA e da chave de acesso

- **IA**: `painel/engine.mjs` usa o pacote `eve` em `127.0.0.1:2000` com login de *assinatura* do ChatGPT. Assinatura de consumidor não é credencial de API, o código recusa hosts não locais e, na nuvem, a IA está fixada como desligada (`aiEnabled:false`). Por isso nunca autentica.
- **Chave**: gerada aleatoriamente e salva só em `.data/access-key` no notebook; a nuvem guarda apenas `SHA-256` em `PANEL_KEY_HASH`. Sem conta individual e sem recuperação se o arquivo local se perder.

## Correções na v1.0

| Problema | Solução |
| --- | --- |
| Documento JSON único | Tabelas normalizadas `fin_*` / `os_*` com versão por registro |
| Chave compartilhada | Conta única com e-mail + senha (PBKDF2), sessão HttpOnly, limite de tentativas, sair de todos os aparelhos |
| IA que não autentica | Assistente por regras (grátis) + IA opcional via segredo no servidor, desligada por padrão |
| Faltas financeiras | Contas, transferências, reserva, conciliação, recibos com OCR local, recorrências, delivery, relatórios, CSV |
| PWA | Manifesto completo, ícones 192/512/maskable/apple, service worker sem cache de dados |

## Correções após revisão externa (15/10/2026)

Achados de uma revisão do commit `50a8112`, todos confirmados na leitura do código e cobertos por teste:

- **Lote somava errado contra a reserva.** Confirmar em lote verificava cada despesa sozinha contra o mesmo saldo. Agora soma o efeito de todas as linhas por conta e verifica uma vez.
- **Voltar para pendente ou excluir.** Ao voltar uma entrada para pendente ou excluí-la, o saldo diminui. Isso agora passa pela mesma proteção da reserva (no lote e na exclusão individual, com `?confirm_reserve=1`).
- **CSV confirmado sem proteção.** A importação como “confirmada” agora verifica o efeito líquido do arquivo e pede confirmação se avançar sobre a reserva.
- **Gravações simultâneas.** Antes, duas saídas que cabiam sozinhas podiam passar juntas, por exemplo uma do celular e outra do notebook. Agora a gravação inclui uma verificação da revisão (`revisionCheck`) e é desfeita inteira, com 409, se outra gravação ocorrer entre a verificação e a escrita.
  - Esse caminho foi testado com SQLite (`tests/unit/revision-guard.test.mjs`).
  - No `wrangler pages dev` os pedidos chegaram em série, então o teste ponta a ponta exercitou o 428, não o 409.
- **Transferências no CSV.** Linhas do tipo `TRANSFER`/`TOPUP`/`EXCHANGE` (Revolut) e descrições como “To EUR…”, “Exchanged to…” e “Transferência entre contas” entram como **ajuste pendente**, categoria “Transferência (revisar)”. Assim ficam fora de receitas e despesas até o titular revisar.
  - Um `TRANSFER` pode ser pagamento a outra pessoa. Nesse caso, mude o tipo para despesa.
- **Deduplicação.** Duas compras idênticas no mesmo arquivo (mesma conta, data, valor e descrição) agora são duas. A 2ª, 3ª… recebem número de ocorrência no código de importação. Reimportar o mesmo arquivo continua não duplicando, e a 1ª ocorrência mantém o código antigo, compatível com o que já foi importado.
- **Teste de lote.** “Classificar e confirmar” agora confirma o lote pela tela e confere o status.

Resultado nesta máquina (Node 22, wrangler 4.42 local, Chromium): `npm test` 29/29 e `npm run test:e2e` 34/34. **Ainda não verificado:** CI no GitHub (nenhuma execução registrada), versão publicada, migração em produção, iPhone físico.

## Publicação

Cloudflare Pages + Functions + D1 cabem no plano gratuito. R2 não foi usado (exige cartão). O ambiente de desenvolvimento usado na entrega não tinha credenciais nem acesso de rede à Cloudflare; a publicação é feita pelo titular (README) ou pelo GitHub Actions.
