import { z } from 'zod'

/** A recording track. The microphone and the system audio are written separately and never mixed. */
export const TrackId = z.enum(['mic', 'system'])
export type TrackId = z.infer<typeof TrackId>

/** Processing stages. Each lives its own life and is restarted on its own:
 *  a failed transcription must not require recording the call again. */
export const Stage = z.enum(['recording', 'transcribing', 'diarizing', 'identifying', 'summarizing', 'done'])
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

/** A stretch of speech from one cluster within one track.
 *  Cluster numbering is local to a track: system:0 and mic:0 are different people. */
export const SpeakerTurn = z.object({
  start: z.number(),
  end: z.number(),
  cluster: z.number().int().nonnegative()
})
export type SpeakerTurn = z.infer<typeof SpeakerTurn>

export const Speaker = z.object({
  /** A global identifier of the form `mic:0` / `system:1`. */
  id: z.string(),
  track: TrackId,
  cluster: z.number().int().nonnegative(),
  /**
   * The number for the caption: "Speaker 2".
   *
   * Kept apart from the cluster, because the cluster is voice separation's
   * internal number and is also what a voice print is taken by. In a
   * conversation with two other people the clusters may well come out as 0 and 3,
   * and "Speaker 4" would only confuse the person.
   */
  number: z.number().int().positive().optional(),
  name: z.string().optional(),
  /** Matched the voice profile of the application's owner. */
  isMe: z.boolean().default(false),
  /** Where the name came from: filled in from a voice print or entered by hand. */
  nameSource: z.enum(['manual', 'voice-match', 'none']).default('none'),
  /** Cosine closeness to the profile in the registry, if the name was filled in automatically. */
  matchScore: z.number().optional()
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
  /** A speaker identifier or a free-form name: the LLM does not always hit the registry. */
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

/**
 * Who last touched a summary, when it was not a model.
 *
 * The value is stored in the file and compared against, so it is never
 * translated. It used to be written through the translation function, and the
 * moment the interface was switched to English the marker stopped matching the
 * constant it is compared with: the "edited by hand" note disappeared for
 * everyone not using Russian.
 */
export const MANUAL_SUMMARY_MODEL = 'manual'

/** The same, for an edit that arrived from an agent over MCP. */
export const AGENT_SUMMARY_MODEL = 'agent'

/** What earlier versions wrote, still recognised so old summaries keep their note. */
export const LEGACY_MANUAL_SUMMARY_MODELS: readonly string[] = ['вручную', 'by hand']

/** Whether a summary was edited by a person rather than produced by a model. */
export function isManualSummary(model: string | undefined): boolean {
  return model === MANUAL_SUMMARY_MODEL || (model !== undefined && LEGACY_MANUAL_SUMMARY_MODELS.includes(model))
}

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
    diarization: z.string().optional(),
    llm: z.string().optional()
  }).default({}),
  /** The project folder this call is handed to a coding agent in. */
  projectPath: z.string().optional(),
  /**
   * How many people were in the conversation, when that is known.
   *
   * Voice separation itself guesses this badly: on a half-hour recording of three
   * people it found fifty "participants". When the number is known it is set
   * firmly, and the answer becomes exact.
   */
  speakerCount: z.number().int().min(1).max(20).optional(),
  /** Marks on important moments, placed during the recording. */
  marks: z.array(Mark).default([]),
  /** The calendar event the title and the participants came from. */
  calendarEventId: z.string().optional(),
  /** Who the calendar expected at the meeting, a hint when naming participants. */
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

/** The voice print of a known person. Biometrics, so local only. */
export const VoiceProfile = z.object({
  id: z.string(),
  name: z.string(),
  isMe: z.boolean().default(false),
  /** The averaged embedding; its length depends on the model. */
  embedding: z.array(z.number()),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** How many times the profile has been confirmed: the more, the steadier the average. */
  samples: z.number().int().default(1)
})
export type VoiceProfile = z.infer<typeof VoiceProfile>
