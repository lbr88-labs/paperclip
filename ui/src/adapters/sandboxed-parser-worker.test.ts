import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { getWorkerBootstrapSource } from "./sandboxed-parser-worker";

describe("sandboxed parser worker bootstrap", () => {
  it("starts with read-only browser storage getters and parses streamed output", () => {
    const browserGlobals = Object.defineProperties({}, {
      caches: { get: () => ({ open: () => "exposed" }) },
      indexedDB: { get: () => ({ open: () => "exposed" }) },
    });
    const self = Object.create(browserGlobals) as {
      caches?: unknown;
      indexedDB?: unknown;
      onmessage?: (event: { data: unknown }) => void;
      postMessage: (message: unknown) => void;
    };
    const messages: unknown[] = [];
    self.postMessage = (message) => messages.push(message);

    runInNewContext(getWorkerBootstrapSource(), { self });
    expect(self.caches).toBeUndefined();
    expect(self.indexedDB).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(self, "caches")?.writable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(self, "indexedDB")?.writable).toBe(false);

    self.onmessage?.({
      data: {
        type: "init",
        source: "module.exports.parseStdoutLine = (line, ts) => [{ kind: 'assistant', text: JSON.parse(line).delta, ts }];",
      },
    });
    self.onmessage?.({
      data: { type: "parse", id: 1, line: '{"delta":"Live text"}', ts: "now" },
    });
    expect(messages).toEqual([
      { type: "ready" },
      { type: "result", id: 1, entries: [{ kind: "assistant", text: "Live text", ts: "now" }] },
    ]);
  });
});
