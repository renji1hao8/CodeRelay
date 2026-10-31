import { readFile } from "node:fs/promises";
import type { ChatMessage } from "@remote-cc/shared";
import { desktopConnection, forgetDesktopConnection } from "./cdp.ts";
const source = readFile(new URL("./codex-live.js", import.meta.url), "utf8");
const cache = new Map<string, { at: number; busy?: boolean; messages: ChatMessage[] }>();
const flights = new Set<string>();
let unavailableUntil = 0;
export function codexLive(id: string) {
  const prior = cache.get(id);
  if (!flights.has(id) && Date.now() >= unavailableUntil && (!prior || Date.now() - prior.at > 400)) {
    flights.add(id);
    void (async () => {
      try {
        const connection = await desktopConnection("codex");
        await connection.evaluate(await source);
        const value = await connection.evaluate(`globalThis.__remoteccCodexLive.snapshot(${JSON.stringify(id)})`);
        cache.set(id, { at: Date.now(), busy: value?.busy, messages: (value?.items || []).filter((item: any) => item.text).map((item: any) => ({ uuid: `codex-item-${id}-${item.id}`, role: "assistant", ts: item.ts, blocks: [{ type: "text", text: item.text }] })) });
        if (cache.size > 12) cache.delete(cache.keys().next().value!);
      } catch { unavailableUntil = Date.now() + 30000; forgetDesktopConnection("codex"); cache.clear(); }
      finally { flights.delete(id); }
    })();
  }
  return prior && Date.now() - prior.at < 10000 ? prior : { messages: [] };
}
