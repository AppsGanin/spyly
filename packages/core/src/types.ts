import { z } from 'zod'

/** Дорожка записи. Микрофон и системный звук пишутся раздельно и никогда не микшируются. */
export const TrackId = z.enum(['mic', 'system'])
export type TrackId = z.infer<typeof TrackId>

/** Этапы обработки. Каждый живёт своей жизнью и перезапускается отдельно:
 *  упавшая расшифровка не должна требовать перезаписи созвона. */
export const Stage = z.enum(['recording', 'transcribing', 'diarizing', 'identifying', 'summarizing', 'done'])
export type Stage = z.infer<typeof Stage>

export const StageState = z.enum(['pending', 'running', 'done', 'failed', 'skipped'])
export type StageState = z.infer<typeof StageState>

export const Word = z.object({
  text: z.string(),
  /** Секунды от начала записи. Общая шкала для обеих дорожек. */
  start: z.number(),
  end: z.number(),
  confidence: z.number().optional()
})
export type Word = z.infer<typeof Word>

export const AsrSegment = z.object({
  text: z.string(),
  start: z.number(),
  end: z.number(),
  words: z.array(Word).default([])
})
export type AsrSegment = z.infer<typeof AsrSegment>

export const AsrResult = z.object({
  track: TrackId,
  language: z.string(),
  segments: z.array(AsrSegment)
})
export type AsrResult = z.infer<typeof AsrResult>

/** Отрезок речи одного кластера внутри одной дорожки.
 *  Нумерация кластеров локальна для дорожки: system:0 и mic:0 — разные люди. */
export const SpeakerTurn = z.object({
  start: z.number(),
  end: z.number(),
  cluster: z.number().int().nonnegative()
})
export type SpeakerTurn = z.infer<typeof SpeakerTurn>

export const Speaker = z.object({
  /** Глобальный идентификатор вида `mic:0` / `system:1`. */
  id: z.string(),
  track: TrackId,
  cluster: z.number().int().nonnegative(),
  /**
   * Номер для подписи: «Участник 2».
   *
   * Отдельно от кластера, потому что кластер — внутренний номер разделения по
   * голосам, и он же нужен, чтобы снять слепок. У человека в разговоре из двух
   * собеседников кластеры вполне могут оказаться 0 и 3, и «Участник 4» его
   * только запутает.
   */
  number: z.number().int().positive().optional(),
  name: z.string().optional(),
  /** Совпал с профилем голоса владельца приложения. */
  isMe: z.boolean().default(false),
  /** Откуда взялось имя: подставлено по слепку голоса или введено руками. */
  nameSource: z.enum(['manual', 'voice-match', 'none']).default('none'),
  /** Косинусная близость к профилю из реестра, если имя подставлено автоматически. */
  matchScore: z.number().optional()
})
export type Speaker = z.infer<typeof Speaker>

/** Реплика после слияния дорожек — единица, которую видит пользователь. */
export const Utterance = z.object({
  id: z.string(),
  speakerId: z.string(),
  track: TrackId,
  start: z.number(),
  end: z.number(),
  text: z.string(),
  words: z.array(Word).default([]),
  /** Черновик из live-режима, будет заменён финальным проходом. */
  provisional: z.boolean().default(false)
})
export type Utterance = z.infer<typeof Utterance>

export const ActionItem = z.object({
  text: z.string(),
  /** Идентификатор спикера или свободное имя — LLM не всегда попадает в реестр. */
  assignee: z.string().optional(),
  due: z.string().optional(),
  /**
   * Сделана ли. Живёт в самом конспекте, а не рядом с ним: галочку ставит и
   * человек в приложении, и агент через MCP, и обе стороны должны видеть одно
   * и то же.
   */
  done: z.boolean().default(false)
})
export type ActionItem = z.infer<typeof ActionItem>

export const Summary = z.object({
  tldr: z.string(),
  keyPoints: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  actionItems: z.array(ActionItem).default([]),
  questions: z.array(z.string()).default([]),
  generatedAt: z.string(),
  model: z.string().optional()
})
export type Summary = z.infer<typeof Summary>

/** Отметка «это важно», поставленная по ходу разговора. */
export const Mark = z.object({
  id: z.string(),
  /** Секунда от начала записи. */
  at: z.number(),
  note: z.string().default('')
})
export type Mark = z.infer<typeof Mark>

export const MeetingMeta = z.object({
  id: z.string(),
  title: z.string(),
  /**
   * Название придумано приложением, а не человеком.
   *
   * Такое название можно заменить осмысленным, когда разговор расшифрован.
   * Название, данное человеком, не трогаем никогда.
   */
  titleAuto: z.boolean().default(false),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  durationSec: z.number().default(0),
  language: z.string().default('ru'),
  sources: z.object({
    mic: z.boolean().default(true),
    system: z.boolean().default(true),
    micDeviceLabel: z.string().optional(),
    /** Приложение, чей звук писали, если захват был не общесистемным. */
    systemScope: z.string().optional()
  }),
  stages: z.partialRecord(Stage, StageState).default({}),
  /** Человекочитаемая причина, если какой-то этап упал. */
  errors: z.record(z.string(), z.string()).default({}),
  providers: z.object({
    asr: z.string().optional(),
    diarization: z.string().optional(),
    llm: z.string().optional()
  }).default({}),
  /** Папка проекта, в которую этот созвон отдают кодинг-агенту. */
  projectPath: z.string().optional(),
  /**
   * Сколько человек было в разговоре, если известно.
   *
   * Само разделение по голосам угадывает это плохо: на получасовой записи
   * троих человек оно нашло полсотни «участников». Когда число известно, оно
   * задаётся жёстко — и ответ становится точным.
   */
  speakerCount: z.number().int().min(1).max(20).optional(),
  /** Отметки важных мест, поставленные во время записи. */
  marks: z.array(Mark).default([]),
  /** Событие календаря, из которого взялись название и участники. */
  calendarEventId: z.string().optional(),
  /** Кого календарь ждал на встрече — подсказка при назывании участников. */
  calendarParticipants: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([])
})
export type MeetingMeta = z.infer<typeof MeetingMeta>

/** Полный созвон: мета + расшифровка. Лежит на диске как набор файлов. */
export const Meeting = MeetingMeta.extend({
  speakers: z.array(Speaker).default([]),
  utterances: z.array(Utterance).default([]),
  summary: Summary.optional()
})
export type Meeting = z.infer<typeof Meeting>

/** Слепок голоса известного человека. Биометрия — только локально. */
export const VoiceProfile = z.object({
  id: z.string(),
  name: z.string(),
  isMe: z.boolean().default(false),
  /** Усреднённый embedding; длина зависит от модели. */
  embedding: z.array(z.number()),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Сколько раз профиль подтверждали — чем больше, тем надёжнее среднее. */
  samples: z.number().int().default(1)
})
export type VoiceProfile = z.infer<typeof VoiceProfile>
