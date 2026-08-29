#!/usr/bin/env node
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildAgentPrompt,
  DEFAULT_PROMPT_TEMPLATES,
  humanDuration,
  renderPlainText,
  renderSummaryMarkdown,
  renderTranscriptMarkdown
} from '@spyly/core'
import { listMeetings, readMeeting, searchMeetings, storageRoot } from '@spyly/mcp-server/dist/store.js'

const HELP = `spyly — созвоны в терминале

  spyly list [N]              последние встречи (по умолчанию 20)
  spyly last                  расшифровка последней встречи
  spyly show <id>             расшифровка встречи
  spyly summary <id>          только конспект
  spyly search <запрос>       поиск по расшифровкам
  spyly prompt <id> [шаблон]  готовый промпт для кодинг-агента
  spyly where                 где лежат записи
  spyly mcp                   запустить MCP-сервер (stdio)

Форматы: --format md|txt|json (по умолчанию md)
Шаблоны промпта: ${DEFAULT_PROMPT_TEMPLATES.map((t) => t.id).join(', ')}

Пример: spyly last | claude -p "сделай тикеты"
`

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback
}

function render(meeting: NonNullable<Awaited<ReturnType<typeof readMeeting>>>, format: string): string {
  if (format === 'json') return JSON.stringify(meeting, null, 2)
  if (format === 'txt') return renderPlainText(meeting)
  return renderTranscriptMarkdown(meeting)
}

async function resolveMeeting(id: string) {
  const meeting = await readMeeting(id)
  if (!meeting) {
    process.stderr.write(`Встреча ${id} не найдена. Посмотрите список: spyly list\n`)
    process.exit(1)
  }
  return meeting
}

async function main(): Promise<void> {
  const [command = 'help', ...rest] = process.argv.slice(2)
  const format = flag('format', 'md')

  switch (command) {
    case 'list': {
      const limit = Number(rest[0] ?? 20)
      const meetings = await listMeetings(Number.isFinite(limit) ? limit : 20)
      if (meetings.length === 0) {
        process.stdout.write(`Записей нет. Папка: ${storageRoot()}\n`)
        return
      }
      for (const meeting of meetings) {
        const when = new Date(meeting.startedAt).toLocaleString('ru-RU')
        process.stdout.write(`${meeting.id}\n  ${meeting.title} · ${when} · ${humanDuration(meeting.durationSec)}\n`)
      }
      return
    }

    case 'last': {
      const [latest] = await listMeetings(1)
      if (!latest) {
        process.stdout.write('Записей пока нет.\n')
        return
      }
      process.stdout.write(render(await resolveMeeting(latest.id), format))
      return
    }

    case 'show': {
      const id = rest[0]
      if (!id) return void process.stderr.write('Укажите идентификатор встречи\n')
      process.stdout.write(render(await resolveMeeting(id), format))
      return
    }

    case 'summary': {
      const id = rest[0]
      if (!id) return void process.stderr.write('Укажите идентификатор встречи\n')
      const meeting = await resolveMeeting(id)
      process.stdout.write(renderSummaryMarkdown(meeting))
      return
    }

    case 'search': {
      const query = rest.filter((a) => !a.startsWith('--')).join(' ')
      if (!query) return void process.stderr.write('Укажите, что искать\n')
      const hits = await searchMeetings(query, 20)
      if (hits.length === 0) {
        process.stdout.write(`По запросу «${query}» ничего не нашлось.\n`)
        return
      }
      for (const hit of hits) {
        process.stdout.write(`${hit.meeting.id}  ${hit.meeting.title}\n`)
        for (const snippet of hit.snippets) process.stdout.write(`    ${snippet}\n`)
      }
      return
    }

    case 'prompt': {
      const id = rest[0]
      if (!id) return void process.stderr.write('Укажите идентификатор встречи\n')
      const templateId = rest[1] ?? 'tasks'
      const template =
        DEFAULT_PROMPT_TEMPLATES.find((t) => t.id === templateId) ?? DEFAULT_PROMPT_TEMPLATES[0]!
      process.stdout.write(buildAgentPrompt({ template, meeting: await resolveMeeting(id) }))
      return
    }

    case 'where': {
      process.stdout.write(`${storageRoot()}\n`)
      return
    }

    case 'mcp': {
      // The server lives in a module of its own; it is started as a child process so
      // that stdio goes to it whole and unmixed.
      const dirname = path.dirname(fileURLToPath(import.meta.url))
      const serverPath = path.resolve(dirname, '../../mcp-server/dist/index.js')
      const child = spawn(process.execPath, [serverPath], { stdio: 'inherit' })
      child.on('close', (code) => process.exit(code ?? 0))
      return
    }

    default:
      process.stdout.write(HELP)
  }
}

await main()
