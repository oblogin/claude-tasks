# claude-tasks

Плагин **task** для Claude Code: план задач проекта в `Docs/Tasks/` — эпики, фичи, задачи, бэклог идей и граф зависимостей в обычном Markdown. Читается в Obsidian без плагинов, ведётся людьми и агентами через команды `/task:*`.

> Черновик. Полное описание — в задаче T-015.

## Установка (локально, из этого репозитория)

```bash
claude plugin marketplace add C:\AI\claude-tasks
claude plugin install task@claude-tasks --scope local
```

- `--scope local` — плагин включён только в текущем репозитории; `--scope user` — во всех проектах.
- Терминал, десктоп-приложение и VS Code используют одни настройки: установленный плагин виден везде.
- Плагин грузится прямо из папки репозитория: правки подхватываются без переустановки — в новой сессии или после `/reload-plugins` в текущей.
- Проверка манифестов: `claude plugin validate ./plugin` и `claude plugin validate .`

## Команды

| Команда | Что делает | Статус |
|---------|-----------|--------|
| `/task:help` | Справка | заглушка |
| `/task:init` · `create` · `split` · `next` · `done` · `replan` · `idea` · `board` | Работа с планом | в разработке |

Команды вызываются с префиксом `task:`. Без префикса команда тоже работает, если её имя не занято (например, `/help` и `/init` заняты встроенными командами Claude Code).

## Устройство репозитория

```
.claude-plugin/marketplace.json   ← репозиторий = локальный маркетплейс
plugin/                           ← сам плагин
  .claude-plugin/plugin.json
  skills/format/SKILL.md          ← спецификация формата задач (скил task:format)
  skills/help/SKILL.md            ← /task:help
  templates/                      ← шаблоны файлов задач
Docs/Tasks/                       ← план разработки самого плагина (в плагин не входит)
```
