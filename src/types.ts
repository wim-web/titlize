export interface SessionState {
  sessionId: string;
  stopCount: number;
  lastTurnId: string | null;
  pendingUpdate: boolean;
  lastAutoTitle: string | null;
  pendingTitle: string | null;
  pendingPreviousTitle: string | null;
  pendingPreviousTitleKnown: boolean;
  autoUpdateDisabled: boolean;
  lastSuccessAt: string | null;
  updatedAt: string;
}

export interface TitleConfig {
  every: number;
  maxChars: number;
  statePath: string;
}
