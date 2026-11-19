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
