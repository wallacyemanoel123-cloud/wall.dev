# WALL OS v1.1 (com WALL Finance)

**WALL OS** é a plataforma pessoal (hoje, planejamento, metas, projetos, hábitos, estudos); **WALL Finance** é o módulo financeiro independente dentro dela. Aplicativo web responsivo, instalável como PWA (celular e notebook), com conta única, banco de dados persistente na Cloudflare (D1) e custo operacional zero dentro do plano gratuito.

> **Este repositório é público.** Ele guarda apenas código. Saldos, backups, senhas e chaves **nunca** devem ser enviados para cá.

## O que o sistema faz

| Área | Recursos |
| --- | --- |
| Painel | Patrimônio (com taxa EUR→BRL manual), disponível, reserva, receitas e despesas do mês, contas, orçamentos, metas, pendentes |
| Contas e reservas | Contas independentes em EUR ou BRL; saldo de referência (fotografia com data, fonte e status); contas fora do orçamento (ex.: moedas do ônibus); **reservas protegidas dentro de uma conta** (meta, valor reservado, déficit) |
| Lançamentos | Receita/despesa com edição, exclusão lógica, categorias, status (confirmada/pendente), anexos, filtros, busca e **ações em lote** (confirmar, classificar, excluir) |
| Importar extrato | CSV de qualquer banco (preset Revolut); mapeamento de colunas, prévia, alerta de duplicados, linhas antes do saldo de referência desmarcadas, reimportação sem duplicar |
| Transferências | Duas pernas ligadas (saída e entrada), inclusive entre moedas; **não** contam como receita nem despesa |
| Conciliação | Compara o saldo do app do banco com o calculado; registrar, lançar ajuste ou usar como novo ponto de partida, sempre com confirmação |
| Recibos | Foto/screenshot/PDF → OCR **no aparelho** → data, estabelecimento, valor e moeda → duplicidades → **conta de origem sugerida** → revisar → registrar **ou conciliar** com lançamento existente. Enviar imagem nunca desconta dinheiro |
| Orçamentos | Diário, semanal (seg–dom) e mensal, por categoria ou geral |
| Fixas e planejadas | Recorrentes com próxima data e despesas/receitas planejadas; nada entra no saldo até você tocar em “Lançar” |
| Delivery | Turnos com horas, km, pedidos, ganhos, gorjetas e custos; €/hora e €/km; lançamento opcional no extrato |
| Metas financeiras | Patrimônio, reserva (contas + valores reservados), conta ou manuais |
| Investimentos | Operações (compra, venda, aporte, resgate, rendimento, taxa) e posição; nenhuma ordem é executada |
| Lista de desejos | Prioridade, preço, link, situação, ordem; indica se cabe no disponível |
| Relatórios | Mês a mês, 6 meses em gráfico, categorias, por dia; CSV; impressão/PDF |
| WALL OS | Hoje (visão do dia), planejamento, metas de curto/médio/longo prazo, projetos e negócios, calendário, diário, checklist, hábitos (sono, hidratação, exercício), estudos de inglês. Criar, editar, concluir, arquivar e reordenar pela interface |
| Assistente WALL | Responde por regras (grátis): disponível hoje, quanto falta na reserva, contas da semana, ganhos do delivery, economia do mês, tarefas de hoje, progresso das metas. IA externa opcional, desligada |
| Interface | 100% pt-BR, datas dd/mm/aaaa em campos próprios (sem controles nativos em inglês), modo claro/escuro/automático, notebook e iPhone |
| Dados | Backup JSON (com ou sem anexos), restauração, importação do piloto, configuração inicial por JSON, auditoria, sessões |

**Não existe integração bancária.** Nenhum saldo é lido automaticamente e nenhuma movimentação é criada sem uma ação sua.

## Regras financeiras

- Valores são guardados em **centavos inteiros** (sem erros de arredondamento).
- **Saldo calculado** = última fotografia marcada como *ponto de partida* + lançamentos **confirmados** posteriores a ela. Pendentes aparecem separados e não alteram o saldo.
- **Transferências** criam duas pernas com o mesmo `transfer_id`. Excluir uma exclui as duas.
- **Reserva protegida**: qualquer saída (despesa, transferência, ajuste negativo) exige confirmação explícita. O servidor bloqueia sem ela (HTTP 428).
- **Reserva dentro da conta** (`fin_reserves`): separa parte do saldo; não é despesa e não duplica saldo. Disponível = saldo − contas-reserva − valores reservados − contas fora do orçamento. Gasto que avançaria sobre o reservado pede confirmação (HTTP 428). Não é possível reservar mais do que existe na conta.
- **Orçamento diário** mostra quanto pode ser usado de fato: o menor entre o que resta do limite e o disponível livre de reservas.
- **Confirmadas, pendentes, planejadas e recorrentes** ficam separadas; só confirmadas alteram o saldo.
- **Fotografias históricas** (ex.: saldos iniciais) entram como “a confirmar” e não geram débitos retroativos.
- **Auditoria**: toda criação, edição, exclusão, conciliação, importação e restauração grava o antes e o depois (`fin_audit` / `os_audit`).
- **Edição em dois aparelhos ao mesmo tempo**: cada registro tem versão; a gravação com versão antiga é recusada (HTTP 409) em vez de sobrescrever.

## Arquitetura

```
public/              App (HTML, CSS, JS puro, sem build) + PWA (manifest, sw.js, ícones)
  shared/            Regras puras usadas no navegador E no servidor (dinheiro, saldos, recibos)
  js/                Telas e utilidades da interface
functions/api/       Cloudflare Pages Function: encaminha /api/* para server/
server/              API: autenticação, financeiro (fin), WALL OS (os), backup, assistente
migrations/          Esquema do banco D1 (tabelas fin_*, os_*, auth_*)
scripts/             Hash de senha, ícones, cópia do OCR para public/vendor
tests/unit/          Testes das regras (node --test)
tests/e2e/           Teste ponta a ponta com Pages + D1 locais e dois navegadores
```

- **Separação para comercialização**: o financeiro usa só tabelas `fin_*` e rotas `/api/fin/*`; o WALL OS usa `os_*` e `/api/os/*`. Dá para extrair o WALL Finance sem o WALL OS.
- **Segurança**: senha com PBKDF2-SHA256 (100 mil iterações), guardada só como hash em segredo da Cloudflare; sessão em cookie `__Host-` `HttpOnly; Secure; SameSite=Lax` (30 dias), guardada como hash no banco; limite de 8 tentativas de login a cada 15 min por IP; verificação de origem em toda gravação; CSP restritiva (`default-src 'self'`); anexos servidos com `sandbox`; dados financeiros nunca vão para o cache do service worker.
- **OCR**: Tesseract.js roda no navegador e é servido pelo próprio site (`public/vendor`, gerado no build). A imagem não passa por nenhum serviço de terceiros.

## Publicar (uma vez, ~15 minutos, sem custo)

Pré-requisitos: conta gratuita na Cloudflare e Node.js 20+ no notebook.

1. **Instalar e entrar na Cloudflare**
   ```bash
   npm install
   npx wrangler login
   ```
2. **Criar o banco** e copiar o `database_id` exibido para o `wrangler.toml` (o ID não é segredo):
   ```bash
   npx wrangler d1 create wall-finance
   npm run db:remote
   ```
3. **Criar o projeto Pages** (nome `wall-finance`) e publicar:
   ```bash
   npx wrangler pages project create wall-finance --production-branch main
   npm run deploy
   ```
4. **Banco ligado ao site**: o vínculo `DB` vem do `wrangler.toml` (por isso o `database_id` do passo 2). Confira em Workers & Pages → `wall-finance` → Settings → Bindings.
5. **Criar sua senha** (no seu notebook; a senha não fica salva em lugar nenhum):
   ```bash
   npm run hash-password
   ```
   Depois grave os dois segredos (Settings → Variables and Secrets → *Encrypt*), ou pelo terminal:
   ```bash
   npx wrangler pages secret put OWNER_EMAIL --project-name wall-finance
   npx wrangler pages secret put OWNER_PASSWORD_HASH --project-name wall-finance
   ```
6. Publique de novo (`npm run deploy`) e abra `https://wall-finance.pages.dev`.

### Publicação automática pelo GitHub (opcional)

O workflow `.github/workflows/deploy.yml` roda os testes em todo push e publica quando a branch `main` muda. Configure em GitHub → Settings → Secrets → Actions: `CLOUDFLARE_API_TOKEN` (permissões *Cloudflare Pages: Edit* e *D1: Edit*), `CLOUDFLARE_ACCOUNT_ID` e `D1_DATABASE_ID`.

### Checklist antes de considerar publicado

- [ ] Login com senha errada é recusado; com a certa entra.
- [ ] Criar e editar um lançamento no notebook.
- [ ] Abrir no celular (Safari/Chrome), entrar e ver o mesmo lançamento.
- [ ] Lançar algo no celular e ver aparecer no notebook (até 20 s, ou ao voltar para a aba).
- [ ] Instalar na tela de início (iPhone: Compartilhar → Adicionar à Tela de Início).
- [ ] Baixar um **Backup completo** em Dados e segurança e guardar fora do celular.
- [ ] Abrir `https://wall-finance.pages.dev/api/fin/state` numa janela anônima: precisa responder 401.

## Primeiro uso: saldos iniciais

Entre no app → **Dados e segurança → Configuração inicial**, cole um JSON como o abaixo (com os seus valores; **não** o salve no repositório) e toque em *Aplicar*:

```json
{
  "contas": [
    { "nome": "Conta exemplo EUR", "instituicao": "Banco", "moeda": "EUR", "tipo": "carteira", "saldo": "0,00",
      "data": "2026-10-14", "fonte": "Último registro informado pelo titular", "status": "a_confirmar" },
    { "nome": "Moedas do ônibus", "moeda": "EUR", "tipo": "especie", "fora_do_orcamento": true, "observacao": "Valor não informado" }
  ],
  "reservas": [ { "nome": "Emergência", "conta": "Conta exemplo EUR", "meta": "500,00", "reservado": "0,00" } ],
  "orcamentos": [ { "nome": "Dia a dia", "periodo": "diario", "limite": "5,00", "moeda": "EUR" } ],
  "metas": [ { "nome": "Meta de patrimônio", "tipo": "patrimonio", "valor": "50.000,00", "moeda": "BRL", "prazo": "2027-10-14" } ],
  "wall_os": [ { "modulo": "projeto", "titulo": "Meu projeto", "dados": { "tipo": "negocio" } } ]
}
```

Tipos de conta: `banco`, `carteira`, `especie`, `reserva`, `investimento`. Status: `a_confirmar` ou `confirmado`. Depois, informe a taxa EUR→BRL em **Contas e saldos → Taxa EUR→BRL** para o patrimônio em reais.

Extratos: baixe o CSV no app do banco e use **WALL Finance → Importar extrato**. As linhas entram como pendentes; revise e confirme em lote em Lançamentos.

Vindo do piloto (`wall-finance-pilot`)? No piloto, use *Exportar JSON*; aqui, **Dados e segurança → Importar do piloto**. Nada é apagado.

## Manutenção sem depender de desenvolvedor

| Tarefa | Como |
| --- | --- |
| Atualizar dados | Pelo próprio app, em qualquer aparelho logado |
| Backup | Semanal: Dados e segurança → **Backup completo**. Guarde em local privado (nunca no GitHub) |
| Recuperar dados | Dados e segurança → Restaurar → digite `RESTAURAR` |
| Trocar a senha | `npm run hash-password` → atualize o segredo `OWNER_PASSWORD_HASH` → *Sair de todos os aparelhos* |
| Celular perdido | Dados e segurança → **Sair de todos os aparelhos** e troque a senha |
| Atualizar o código | Alterar → `npm test` → `npm run test:e2e` → `npm run deploy` (ou push na `main`) |
| Banco mudou de esquema | Criar `migrations/000N_descricao.sql` → `npm run db:remote` antes do deploy |
| Ligar IA (opcional, pode ter custo) | Criar chave no provedor → segredo `ANTHROPIC_API_KEY` (e opcional `AI_MODEL`) → ativar em Dados e segurança. Só totais e metas são enviados |
| Limites gratuitos | D1: 5 GB e 5 milhões de leituras/dia; Pages Functions: 100 mil pedidos/dia. Uso pessoal fica muito abaixo |

### Desenvolvimento local

```bash
npm install
cp .dev.vars.example .dev.vars   # preencha com e-mail e hash de teste
npm run db:local
npm run dev                      # http://localhost:8788
npm test                         # regras financeiras, recibos, senha
npm run test:e2e                 # migrações com dados + ponta a ponta com dois navegadores e restauração em banco limpo
```

## Limitações conhecidas (v1.1)

- Sem integração bancária nem cotação automática (por decisão: nada fictício).
- Conta única; multiusuário fica para versões futuras.
- Sincronização por verificação a cada 20 s com o app aberto (e ao voltar para ele); sem notificações push.
- Sem modo offline para gravação: sem internet, o app mostra os dados da última carga e avisa.
- Anexos de até ~1,4 MB cada (imagens são comprimidas automaticamente).
