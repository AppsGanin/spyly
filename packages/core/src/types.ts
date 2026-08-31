import { z } from 'zod'

/** A recording track. The microphone and the system audio are written separately and never mixed. */
export const TrackId = z.enum(['mic', 'system'])
export type TrackId = z.infer<typeof TrackId>

/** Processing stages. Each lives its own life and is restarted on its own:
 *  a failed transcription must not require recording the call again. */
export const Stage = z.enum(['recording', 'transcribing', 'summarizing', 'done'])
export type Stage = z.infer<typeof Stage>

export const StageState = z.enum(['pending', 'running', 'done', 'failed', 'skipped'])
export type StageState = z.infer<typeof StageState>

export const Word = z.object({
  text: z.string(),
  /** Seconds from the start of the recording. A shared scale for both tracks. */
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

/**
 * A side of the conversation.
 *
 * There are exactly two, and which is which follows from the track: the
 * microphone is whoever sits at the computer, the system audio is the other
 * side. Splitting a track further by voice was removed: on a real half-hour
 * conversation between three people it produced fifty "participants", and the
 * names it guessed from voice prints were wrong more often than not.
 */
export const Speaker = z.object({
  /** `mic` or `system`, the same value as the track. */
  id: z.string(),
  track: TrackId
})
export type Speaker = z.infer<typeof Speaker>

/** An utterance after the tracks are merged, the unit the user sees. */
export const Utterance = z.object({
  id: z.string(),
  speakerId: z.string(),
  track: TrackId,
  start: z.number(),
  end: z.number(),
  text: z.string(),
  words: z.array(Word).default([]),
  /** A draft from live mode, to be replaced by the final pass. */
  provisional: z.boolean().default(false)
})
export type Utterance = z.infer<typeof Utterance>

export const ActionItem = z.object({
  text: z.string(),
  /**
   * Who took it on, only when a name was actually spoken.
   *
   * The model is told to leave it empty otherwise: a task signed "Speaker 3"
   * says nothing a person can act on.
   */
  assignee: z.string().optional(),
  due: z.string().optional(),
  /**
   * Whether it is done. It lives in the summary itself rather than beside it:
   * the box is ticked by a person in the application and by an agent over MCP,
   * and both sides have to see the same thing.
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


/** A "this matters" mark, placed during the conversation. */
export const Mark = z.object({
  id: z.string(),
  /** The second from the start of the recording. */
  at: z.number(),
  note: z.string().default('')
})
export type Mark = z.infer<typeof Mark>

export const MeetingMeta = z.object({
  id: z.string(),
  title: z.string(),
  /**
   * The title was invented by the application rather than by a person.
   *
   * Such a title can be replaced with a meaningful one once the conversation has
   * been transcribed. A title given by a person is never touched.
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
    /** The application whose audio was recorded, if the capture was not system-wide. */
    systemScope: z.string().optional()
  }),
  stages: z.partialRecord(Stage, StageState).default({}),
  /** A human-readable reason, if some stage failed. */
  errors: z.record(z.string(), z.string()).default({}),
  providers: z.object({
    asr: z.string().optional(),
    llm: z.string().optional()
  }).default({}),
  /** The project folder this call is handed to a coding agent in. */
  projectPath: z.string().optional(),
  /** Marks on important moments, placed during the recording. */
  marks: z.array(Mark).default([]),
  /** The calendar event the title and the participants came from. */
  calendarEventId: z.string().optional(),
  /** Who the calendar expected at the meeting. */
  calendarParticipants: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([])
})
export type MeetingMeta = z.infer<typeof MeetingMeta>

/** A whole call: the meta plus the transcript. Kept on disk as a set of files. */
export const Meeting = MeetingMeta.extend({
  speakers: z.array(Speaker).default([]),
  utterances: z.array(Utterance).default([]),
  summary: Summary.optional()
})
export type Meeting = z.infer<typeof Meeting>
