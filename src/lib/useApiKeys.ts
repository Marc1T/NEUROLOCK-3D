import { useCallback, useEffect, useState } from 'react';

/**
 * User-provided API keys stored in localStorage.
 *
 * Allow self-hosted players to bring their own Mistral / Groq keys when the
 * deployed instance has no server-side env keys configured. Server-side keys
 * remain the default; user keys, when present, override them on a per-request basis.
 *
 * Keys never leave the browser except in the body of /api/generate-questions
 * and /api/test-key requests directed at the same origin.
 */
export interface UserApiKeys {
  mistral: string;
  groq: string;
}

const STORAGE_KEY = 'neurolock.apiKeys.v1';

const EMPTY: UserApiKeys = { mistral: '', groq: '' };

function read(): UserApiKeys {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw);
    return {
      mistral: typeof parsed.mistral === 'string' ? parsed.mistral : '',
      groq: typeof parsed.groq === 'string' ? parsed.groq : '',
    };
  } catch {
    return EMPTY;
  }
}

function write(keys: UserApiKeys) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    /* quota exceeded / private mode — silently ignore */
  }
}

export function useApiKeys() {
  const [keys, setKeysState] = useState<UserApiKeys>(() => read());

  useEffect(() => { write(keys); }, [keys]);

  const setKey = useCallback((provider: keyof UserApiKeys, value: string) => {
    setKeysState(prev => ({ ...prev, [provider]: value.trim() }));
  }, []);

  const clearKey = useCallback((provider: keyof UserApiKeys) => {
    setKeysState(prev => ({ ...prev, [provider]: '' }));
  }, []);

  return { keys, setKey, clearKey };
}

/**
 * Read the current user keys synchronously (for inclusion in fetch bodies).
 * Use this outside React render paths.
 */
export function getUserApiKeys(): UserApiKeys {
  return read();
}
