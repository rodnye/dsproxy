/** Credentials captured from a logged-in chat.deepseek.com session */
export interface AuthData {
  token: string;
  cookie: string;
  hifDliq: string;
  hifLeim: string;
  wasmUrl: string;
}

export interface Account {
  id: string;
  file: string;
  auth: AuthData;
  cooldownUntil: number;
  failures: number;
  lastUsedAt: number;
}

export interface AccountLease {
  account: Account;
  /** True when the requested sticky account was unusable and another was chosen */
  rotated: boolean;
}

export interface AccountStatus {
  id: string;
  ready: boolean;
  cooldown: boolean;
  cooldownRemainingSec: number;
  failures: number;
  lastUsedAt: number | null;
}
