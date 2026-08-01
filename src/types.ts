export interface NormalizedMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TitleProviderInput {
  messages: NormalizedMessage[];
  previousTitle?: string;
  locale: "ja";
  maxChars: number;
}

export interface TitleProvider {
  generateTitle(input: TitleProviderInput): Promise<string>;
}

export interface SessionState {
  sessionId: string;
  stopCount: number;
  lastTurnId: string | null;
  pendingUpdate: boolean;
  lastAutoTitle: string | null;
  pendingTitle: string | null;
  pendingPreviousTitle: string | null;
  autoUpdateDisabled: boolean;
  lastSuccessAt: string | null;
  updatedAt: string;
}

export interface TitleConfig {
  every: number;
  provider: "codex";
  model: string;
  maxChars: number;
  timeoutMs: number;
  statePath: string;
  appServer: "stdio://";
}
