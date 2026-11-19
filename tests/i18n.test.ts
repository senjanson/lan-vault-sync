import { afterEach, describe, expect, it } from "vitest";
import { setLanguage, t } from "../src/i18n";

describe("i18n", () => {
  afterEach(() => setLanguage(null));

  it("falls back to English and fills in values", () => {
    expect(t("status.peers", { count: 2 })).toBe("LAN Sync: 2 peer(s)");
  });

  it("uses Chinese when Obsidian is set to Chinese", () => {
    setLanguage("zh");
    expect(t("log.restored", { path: "a.md" })).toBe("已还原：a.md");
  });

  it("follows the language Obsidian stores", () => {
    const store = new Map([["language", "zh-TW"]]);
    (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null };
    try {
      expect(t("common.close")).toBe("关闭");
    } finally {
      delete (globalThis as any).localStorage;
    }
  });
});

describe('dates and times', () => {
  it('follow the UI language, not the system region', async () => {
    const { setLanguage, formatTime, formatDate, formatDateTime } = await import('../src/i18n');
    const ts = new Date(2026, 10, 18, 16, 28, 29).getTime();
    try {
      setLanguage('zh');
      expect(formatTime(ts)).toBe('16:28:29');
      expect(formatDate(ts)).toBe('2026/11/18');
      expect(formatDateTime(ts)).toBe('2026/11/18 16:28:29');
      setLanguage('en');
      expect(formatTime(ts)).toBe('4:28:29 PM');
      expect(formatDate(ts)).toBe('11/18/2026');
    } finally {
      setLanguage(null);
    }
  });
});

describe('formatWhen', () => {
  it('gives only the time for today, the date before it for another day, and the year for another year', async () => {
    const { setLanguage, formatWhen } = await import('../src/i18n');
    const now = new Date(2026, 10, 18, 20, 0, 0).getTime();
    const today = new Date(2026, 10, 18, 14, 2, 59).getTime();
    const yesterday = new Date(2026, 10, 17, 14, 2).getTime();
    const lastYear = new Date(2025, 11, 31, 23, 5).getTime();
    try {
      setLanguage('zh');
      expect(formatWhen(today, now)).toBe('14:02');
      expect(formatWhen(yesterday, now)).toBe('11-17 14:02');
      expect(formatWhen(lastYear, now)).toBe('2025-12-31 23:05');
      setLanguage('en');
      expect(formatWhen(today, now)).toBe('2:02 PM');
      expect(formatWhen(yesterday, now)).toBe('Nov 17, 2:02 PM');
      expect(formatWhen(lastYear, now)).toBe('Dec 31, 2025, 11:05 PM');
    } finally {
      setLanguage(null);
    }
  });

  it('says a time just after midnight is today and one just before is not', async () => {
    const { setLanguage, formatWhen } = await import('../src/i18n');
    const now = new Date(2026, 0, 1, 0, 30).getTime();
    try {
      setLanguage('zh');
      expect(formatWhen(new Date(2026, 0, 1, 0, 1).getTime(), now)).toBe('00:01');
      expect(formatWhen(new Date(2025, 11, 31, 23, 59).getTime(), now)).toBe('2025-12-31 23:59');
    } finally {
      setLanguage(null);
    }
  });
});

describe('strings added by modules', () => {
  it('have both an English and a Chinese text', async () => {
    await import('../src/diagnostics/health');
    await import('../src/ui/settings-tab');
    const { tIn } = await import('../src/i18n');
    const keys = [
      'alert.scope-disjoint', 'alert.scope-missing', 'scope.wholeVault', 'scope.folder',
      'health.disconnected', 'health.disconnectedNever', 'health.only',
      'set.scopeHeading', 'set.syncFolder', 'set.syncFolderDesc', 'set.syncFolderWhole', 'set.syncFolderNoLimit',
      'set.syncFolderChoose', 'set.syncFolderFind', 'set.syncFolderMissing',
    ];
    for (const key of keys) {
      expect(tIn('en', key), key).not.toBe(key);
      expect(tIn('zh', key), key).not.toBe(key);
      expect(tIn('zh', key), key).not.toBe(tIn('en', key));
    }
  });
});
