# Ferramentas de escrita para o focus-todo-mcp

**Data:** 2026-10-13
**Status:** aguardando revisão
**Escopo:** v1 — concluir tarefas, pular ocorrências recorrentes, remover duplicatas

## Objetivo

Permitir que o Claude, a pedido do usuário, altere tarefas do Focus To-Do — começando por
"conclua/pule as tarefas atrasadas" e "remova as duplicatas" — com as mudanças propagando para
a nuvem e para os outros clientes pelo sync do próprio app. Hoje o MCP só lê.

Caso de uso futuro que o desenho deve acomodar (fora da v1): "deixa só o que é prioridade hoje
segundo meu Obsidian" — o Claude cruza as prioridades com `list_tasks` e chama as tools de
escrita com IDs explícitos.

## Contexto e fatos verificados

Levantados no spike de 2026-10-13 contra a extensão Focus To-Do 7.1.1 (Chrome 155, Linux).

- **Por que não escrever no LevelDB:** o Chrome mantém o `LOCK` do banco, e uma escrita externa
  não dispara o sync nem a lógica de recorrência.
- **Por que uma instância dedicada do Chrome:** desde o Chrome 136, `--remote-debugging-port`
  é ignorado no user-data-dir padrão (`~/.config/google-chrome`), inclusive em perfis novos dentro
  dele. A escrita exige uma instância com `--user-data-dir` próprio
  (`~/.config/focustodo-chrome`), que passa a ser a janela diária do Focus To-Do do usuário.
  Primeiro sync de uma conta grande (dezenas de milhares de tarefas) leva ~3 min sem indicador visual.
- **Serviços do app:** o bundle (`WebContent/js/main.js`, webpack 4, arquivo único) não expõe
  nada no `window`. Os singletons são alcançáveis via CDP pelas closures (`[[Scopes]]`) de
  métodos de componentes React montados (`#root._reactRootContainer`). Identificação por formato,
  pois os nomes são minificados:
  - **TaskService:** objeto `X.default.shared` com `completeTask`, `deleteCurrentRepeatTask`,
    `deleteTask`.
  - **Synchronizer:** objeto `X.default.shared` com `syncNow`.
- **Comportamento confirmado no spike:**
  - `TaskService.completeTask(id)` conclui e, se recorrente, cria a próxima ocorrência (mesmo
    `rId`) e agenda sync automático (`POST v64/sync`).
  - Registros com `sync: 0` são enviados no próximo sync; o servidor aceitando, voltam a
    `sync: 1`. A mudança chegou ao perfil do Chrome principal pela nuvem.
- **Regras do app (de `fetchTasksOfDeadlineProjectType`):**
  - ativa: `!isFinished && state === 0`
  - atrasada: ativa e `1 <= deadline < início de hoje (horário local)`
  - Com essa regra, a contagem bate com a do app. O reader atual usa `state !== -1` e erra
    (inclui as tarefas com `state: 1`).
- **Duplicatas:** os grupos ativos encontrados eram todos ocorrências da mesma série (`rId`) com o mesmo dia
  de prazo; nenhuma duplicata não recorrente. Criadas em rajadas (dezenas em 10 min) que coincidem
  com abertura/login de clientes. Hipótese não comprovada: cada cliente gera a próxima ocorrência
  por conta própria e o sync junta as cópias.
- **Bug corrigido no caminho:** o parser do WAL perdia sincronia em trailers de bloco < 7 bytes
  (`reader.mjs`, teste em `scripts/reader.test.mjs`).

## Decisões

| Tema | Decisão |
|---|---|
| Deploy | Continua stdio local; MCPB fica como caminho futuro |
| Mecanismo de escrita | Sempre pela lógica do app (TaskService/Synchronizer) via CDP; nunca escrita direta no IndexedDB |
| Fonte da leitura | LevelDB da instância dedicada quando existir; perfis do Chrome padrão como fallback |
| Chrome dedicado fechado | O MCP abre em modo app e deixa aberto |
| Confirmação | Toda escrita pede confirmação (elicitation; fallback em duas chamadas) |
| Escopo v1 | `complete_tasks`, `skip_occurrences`, `remove_duplicate_tasks`, `find_duplicate_tasks` |
| Cliente CDP | `WebSocket` nativo do Node; `engines` passa a `>=22`; sem dependência nova |

## Arquitetura

```
Claude Code ──stdio── index.mjs (MCP server: definição das tools, confirmação, formatação)
                        ├── reader.mjs     leitura do LevelDB (detecção prioriza a instância dedicada)
                        ├── filters.mjs    regras do app: ativa, atrasada, duplicatas
                        └── writer.mjs     operações de escrita de alto nível
                              ├── browser.mjs  acha/abre o Chrome dedicado, acha o target da extensão
                              └── bridge.mjs   localiza serviços via [[Scopes]] e os invoca
```

### `filters.mjs` (novo)
Funções puras, recebendo `now` injetável:
- `isActive(t)`: `!t.isFinished && t.state === 0`
- `isOverdue(t, now)`: ativa e `t.deadline >= 1 && t.deadline < startOfLocalDay(now)`
- `isRecurring(t)`: `t.rCycle > 0`
- `findDuplicateGroups(tasks, { includeNonRecurring })`: agrupa ativas por `rId` + dia local do
  `deadline` (e, se pedido, não recorrentes por `name` + `projectId` + dia). Para cada grupo com 2+
  membros retorna `{ keep, remove[] }`. Critério de `keep`, em ordem: mais `actualPomoNum`; tem
  subtarefa (`hasSubtask`); tem `remark` não vazio; menor `creationDate`.

`index.mjs` passa a usar essas funções em `list_tasks`/`search_tasks`.

### `browser.mjs` (novo)
- `ensureBrowser()`: `GET http://127.0.0.1:${port}/json/version`. Se falhar, executa
  `${chromePath} --user-data-dir=${userDataDir} --remote-debugging-port=${port} --app-id=ngceodoilcgpmkijopinlkmohnfifjfb`
  desanexado (`spawn` com `detached: true`, `stdio: "ignore"`, `unref()`, argv em array) e espera
  a porta responder (timeout 20 s).
- `findExtensionTarget()`: em `/json/list`, o target `page` cuja URL começa com
  `chrome-extension://ngceodoilcgpmkijopinlkmohnfifjfb/WebContent/index.html`. Se não houver,
  abre essa URL via `/json/new` e espera.
- Configuração por ambiente: `FOCUS_TODO_CHROME_PATH` (padrão: primeiro executável encontrado
  entre `google-chrome`, `google-chrome-stable`, `/opt/google/chrome/chrome`),
  `FOCUS_TODO_USER_DATA_DIR` (padrão `~/.config/focustodo-chrome`), `FOCUS_TODO_CDP_PORT`
  (padrão `9222`).

### `bridge.mjs` (novo)
Cliente CDP mínimo (`Runtime.evaluate`, `Runtime.getProperties`, `Runtime.callFunctionOn`) sobre
`WebSocket`.
- `connect(target)`: abre a sessão e espera o app estar pronto: `#root` montado e usuário logado
  (`localStorage` contém `cookie.ACCT`).
- `locateServices()`: percorre a árvore de fibers a partir de `#root._reactRootContainer._internalRoot.current`;
  para cada tipo de componente com `stateNode`, pega um método (seguindo `[[TargetFunction]]` em
  funções bound), lê `[[Scopes]]` (ignorando escopos com mais de 200 variáveis) e testa cada
  variável objeto pelo formato descrito em "Contexto". Guarda os dois singletons em
  `window.__focusTodoMcp = { taskService, synchronizer }` na página para chamadas seguintes; se a
  página recarregar, localiza de novo.
- `call(method, ...args)`: executa `window.__focusTodoMcp.taskService[method](...args)` com
  `awaitPromise` e `returnByValue`.
- `syncAndWait(ids, timeoutMs = 30000)`: chama `synchronizer.syncNow()` e consulta o IndexedDB até
  todas as tarefas afetadas (inclusive as recém-criadas) terem `sync === 1`, ou até o timeout.
- Atualização da UI: chamar o serviço direto altera o banco mas não o estado React da janela.
  Depois do `syncAndWait`, a página é recarregada **somente se não houver pomodoro em andamento**
  (recarregar interromperia o timer). Se o estado do timer não puder ser determinado, não
  recarrega e o retorno da tool avisa que a janela mostra os dados novos no próximo refresh.

### `writer.mjs` (novo)
Interface usada pelo `index.mjs`, fácil de substituir por um falso nos testes:
- `completeTasks(ids)` → para cada id `taskService.completeTask(id)`; resultado
  `{ id, ok, nextOccurrenceId?, error? }` (`nextOccurrenceId` vem de `newTask` no retorno).
- `skipOccurrences(ids)` → `taskService.deleteCurrentRepeatTask(id)`; mesmo formato de resultado.
- `deleteTasks(ids)` → `taskService.deleteTask(id)` (remove também subtarefas e pomodoros da
  cópia). Usado só por `remove_duplicate_tasks`.
Cada chamada executa `ensureBrowser → findExtensionTarget → connect → locateServices`, opera, e
termina com `syncAndWait`.

### `reader.mjs` (alterado)
`findIDBPath()` tenta primeiro
`${FOCUS_TODO_USER_DATA_DIR}/Default/IndexedDB/chrome-extension_ngceodoilcgpmkijopinlkmohnfifjfb_0.indexeddb.leveldb`;
depois a detecção atual. `FOCUS_TODO_IDB_PATH` continua tendo prioridade máxima.
`index.mjs` expõe uma forma de invalidar o cache de 30 s após escritas.

## Tools

Todas recebem `title` e `annotations`.

### Leitura (`readOnlyHint: true`)
- As 6 existentes, sem mudança de nome.
- `list_tasks` e `search_tasks`: `status` ganha `"overdue"`; `"active"` usa `isActive`.
- `taskSummary` ganha `recurring: boolean` e `seriesId` (`rId`), e as datas passam a sair em
  horário local com offset (ex.: `2026-10-13T23:59:59-03:00`).
- **`find_duplicate_tasks`** (nova): parâmetros `include_non_recurring?: boolean` (padrão
  `false`). Retorna os grupos com `keep` e `remove` (resumos das tarefas) e o total de tarefas
  sobrando.

### Escrita

| Tool | Parâmetros | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|---|
| `complete_tasks` | `task_ids: string[]` (1–50), `confirmed?: boolean` | false | false | true | true |
| `skip_occurrences` | `task_ids: string[]` (1–50), `confirmed?: boolean` | false | true | false | true |
| `remove_duplicate_tasks` | `task_ids: string[]` (1–50), `confirmed?: boolean` | false | true | false | true |

**Validação (antes de abrir o navegador, com os dados do reader):**
- `complete_tasks`: o id existe e está ativo. Tarefa já concluída → ignorada e reportada como
  "já concluída" (idempotência).
- `skip_occurrences`: existe, está ativa e é recorrente.
- `remove_duplicate_tasks`: o id está em `remove` de algum grupo de `findDuplicateGroups`
  (com `include_non_recurring: true`). Se o pedido removeria todos os membros de um grupo,
  a tool recusa o grupo inteiro e explica.
IDs inválidos são reportados com o motivo; os válidos seguem. Se nenhum for válido, nada é
executado.

**Confirmação:**
1. Se `server.getClientCapabilities()?.elicitation` existe: `elicitInput` em modo `form` com
   mensagem listando ação e tarefas (`nome · projeto · prazo`; para duplicatas, também a que fica)
   e schema `{ confirm: boolean }`. Executa só com `action === "accept"` e `confirm === true`.
   `confirmed` é ignorado nesse caso.
2. Sem elicitation: chamada sem `confirmed: true` devolve a prévia e não altera nada; o Claude
   mostra a prévia e, com o aceite do usuário, chama de novo com `confirmed: true`.

**Retorno:** texto curto com contagem, IDs das novas ocorrências e erros por tarefa
(ex.: `Concluídas 3/3. Próximas ocorrências: N1 (14/10), …`).

## Erros

| Situação | Mensagem/ação |
|---|---|
| Chrome não encontrado | Diz quais caminhos tentou e cita `FOCUS_TODO_CHROME_PATH` |
| Porta não responde após abrir | Explica que outro Chrome pode estar usando o mesmo user-data-dir sem a flag de debug |
| Extensão não instalada / não logado | Pede para instalar ou logar na instância dedicada |
| Serviços não localizados | Informa a versão da extensão (`manifest.version`) e quais métodos faltaram |
| Falha numa tarefa | Continua as demais; reporta por tarefa |
| Sync sem confirmação em 30 s | Mudanças ficam salvas localmente e sobem no próximo sync; informa quais IDs ficaram pendentes |

## Testes

- **Unitários** (`npm run test:unit`, `node --test scripts/*.test.mjs`):
  - `filters`: ativa e atrasada com `now` fixo (virada do dia, `deadline = 0`, `state = 1`).
  - `findDuplicateGroups`: agrupamento por série e dia, critério de `keep`, não recorrentes.
  - Validação das três tools de escrita, incluindo a recusa de apagar o último membro de um grupo.
  - Fluxo de confirmação com cliente com e sem elicitation, usando um `writer` falso (fronteira
    com o navegador).
- **E2E opcional** (`npm run test:e2e`, só com `FOCUS_TODO_E2E=1` e a instância dedicada aberta):
  cria tarefas descartáveis `MCP-E2E-<timestamp>` via `TaskService.addTask`, inclusive uma
  recorrente diária e uma duplicata dela; exercita concluir, pular e remover; confere o
  IndexedDB; apaga tudo o que criou. Nunca altera tarefas que não criou.
- **Smoke** (`npm test`): mantido.

## Setup e documentação

- `npm run setup:launcher` (Linux): grava `~/.local/share/applications/focus-todo.desktop` com o
  comando do `browser.mjs`, ícone `images/logo128.png` da extensão instalada e
  `StartupWMClass=chrome-ngceodoilcgpmkijopinlkmohnfifjfb-Default`.
- README:
  - novas tools;
  - passo a passo da instância dedicada (instalar extensão, logar, esperar o primeiro sync);
  - **segurança:** a porta de debug escuta em localhost, mas qualquer processo local pode
    controlar essa instância — ela deve ter só o Focus To-Do, sem conta Google nem outros logins;
  - nota sobre duplicatas e vários clientes;
  - remover a afirmação de que o servidor nunca modifica os dados.

## Fora do escopo da v1

- `reschedule_tasks` e o fluxo de prioridades via Obsidian (v2).
- API de sync da nuvem (`v64/sync`) sem navegador.
- Empacotamento MCPB; suporte de launcher para macOS/Windows (só documentação).
- Remover a extensão dos perfis antigos (ação manual do usuário).

## Riscos

- **Atualização da extensão** pode renomear métodos dos serviços: a localização por formato falha
  com mensagem clara, e o E2E detecta.
- **Hipótese das duplicatas:** se a causa for outra (ex.: o próprio servidor), a instância
  dedicada pode aumentar as rajadas enquanto os perfis antigos seguirem ativos.
- **Defasagem de leitura:** o reader lê o LevelDB, que o Chrome grava com pequena defasagem; o
  cache é invalidado após escritas, mas uma leitura imediata pode ainda não refletir o WAL.
