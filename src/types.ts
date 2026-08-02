export interface SessionState {
  sessionId: string;
  stopCount: number;
  lastTurnId: string | null;
  pendingUpdate: boolean;
  lastAutoTitle: string | null;
  autoUpdateDisabled: boolean;
  lastSuccessAt: string | null;
  updatedAt: string;
}

export interface PendingWrite {
  sessionId: string;
  turnId: string;
  baselineTitle: string;
  updatedAt: string;
}

export interface TitleConfig {
  every: number;
  maxChars: number;
  statePath: string;
  codexHome: string;
  appStatePath?: string;
}
