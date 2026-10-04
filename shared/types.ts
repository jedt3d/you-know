// Domain types shared by the Worker, the Durable Object and the client SPA.

export type QuestionType = 'choice' | 'truefalse' | 'short' | 'likert';

export interface QuestionBase {
  id: string;
  prompt: string;
  /** Seconds the host-side question stays open. 5–120. */
  timeLimitSec: number;
  /** Optional illustration — reference only; the binary lives in image storage. */
  image?: QuestionImage;
}

/** Reference to an uploaded image (never the bytes — those live in R2/disk). */
export interface QuestionImage {
  id: string;
  width: number;
  height: number;
}

export interface ChoiceQuestion extends QuestionBase {
  type: 'choice';
  options: string[]; // 2–6 options
  correct: number; // index into options
}

export interface TrueFalseQuestion extends QuestionBase {
  type: 'truefalse';
  answer: boolean;
}

export interface ShortQuestion extends QuestionBase {
  type: 'short';
  accepted: string[]; // 1–8 accepted answers, compared after normalization
  /** Any non-empty answer counts as correct (flat points). */
  acceptAny?: boolean;
}

export interface LikertQuestion extends QuestionBase {
  type: 'likert';
  likertMin: number; // inclusive, e.g. 1
  likertMax: number; // inclusive, e.g. 5; max - min <= 9
  likertLabels?: string[]; // optional label per value
  /** Values that count as correct (flat points). Empty/undefined = unscored poll. */
  correctValues?: number[];
}

export type Question = ChoiceQuestion | TrueFalseQuestion | ShortQuestion | LikertQuestion;

export interface Quiz {
  id: string;
  title: string;
  questions: Question[];
}

// ---------------------------------------------------------------- answers

export type Answer =
  | { kind: 'choice'; option: number }
  | { kind: 'truefalse'; value: boolean }
  | { kind: 'short'; text: string }
  | { kind: 'likert'; value: number };

// ---------------------------------------------------------------- session

export type Phase = 'lobby' | 'question' | 'reveal' | 'ended';

export interface PlayerPublic {
  id: string;
  name: string;
  connected: boolean;
  score: number;
  answered: boolean; // answered the current question
  rank: number; // 1-based, ties share a rank
}

/** The question as sent to clients before reveal — no answer key inside. */
export interface PublicQuestion {
  id: string;
  type: QuestionType;
  prompt: string;
  timeLimitSec: number;
  image?: QuestionImage; // reference only; served from /api/images/:id
  options?: string[]; // choice (texts are public; correct index is not)
  likertMin?: number;
  likertMax?: number;
  likertLabels?: string[];
}

export interface RevealRow {
  label: string;
  count: number;
  correct?: boolean; // this row was the correct choice
}

export interface RevealView {
  kind: QuestionType;
  rows: RevealRow[]; // distribution for choice/truefalse/likert
  correctLabel?: string; // e.g. "Tokyo" or "True"
  accepted?: string[]; // short answers (shown at reveal)
  average?: number; // likert mean, 1 decimal
}

export interface YouView {
  id: string;
  name: string;
  score: number;
  rank: number;
  answered: boolean;
  answer: Answer | null;
  lastGained: number;
  lastCorrect: boolean | null; // null = unscored (likert)
}

export interface SessionStateView {
  code: string;
  title: string;
  phase: Phase;
  version: number;
  questionCount: number;
  questionIndex: number; // -1 in lobby, questionCount when ended
  questionStartedAt: number; // ms epoch of the current/last question start
  serverTime: number; // ms epoch, for clock-offset sync
  players: PlayerPublic[];
  question: PublicQuestion | null; // during question/reveal
  reveal: RevealView | null; // during reveal
  you: YouView | null; // player role only
}

/** GET /api/sessions/:code — unauthenticated summary for the join screen. */
export interface SessionSummary {
  exists: boolean;
  title: string;
  phase: Phase;
  playerCount: number;
}
