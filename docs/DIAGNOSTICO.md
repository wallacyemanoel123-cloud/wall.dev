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

## Publicação

Cloudflare Pages + Functions + D1 cabem no plano gratuito. R2 não foi usado (exige cartão). O ambiente de desenvolvimento usado na entrega não tinha credenciais nem acesso de rede à Cloudflare; a publicação é feita pelo titular (README) ou pelo GitHub Actions.
