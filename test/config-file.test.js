import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { expect, test } from "vitest";

import { updateFallbackOptions } from "../lib/config-file.js";

test("updates only fallback options and preserves unrelated JSONC settings", async () => {
  const home = await mkdtemp(
    path.join(process.env.TMPDIR ?? os.tmpdir(), "model-fallback-config-"),
  );
  const directory = path.join(home, ".config", "opencode");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "opencode.jsonc"),
    `{
  // preserve this comment
  "model": "kimi/k3",
  "plugins": [
    "opencode-kimi-meter@0.1.7",
    {
      "package": "@kingychiu/opencode-model-fallback@1.1.1",
      "options": {
        "mappings": { "kimi/k3": "go/kimi-k3" },
        "cooldown_seconds": 3600
      }
    }
  ]
}
`,
  );

  await updateFallbackOptions(
    { mappings: { "kimi/k3": "go/kimi-k3", "go/kimi-k3": "go/deepseek" } },
    { home, env: {} },
  );

  const source = await readFile(path.join(directory, "opencode.jsonc"), "utf8");
  expect(source).toContain("// preserve this comment");
  const config = parse(source);
  expect(config.model).toBe("kimi/k3");
  expect(config.plugins[0]).toBe("opencode-kimi-meter@0.1.7");
  expect(config.plugins[1].options.cooldown_seconds).toBe(3600);
  expect(config.plugins[1].options.mappings["go/kimi-k3"]).toBe("go/deepseek");
});

test("converts a string plugin entry to an options object", async () => {
  const home = await mkdtemp(
    path.join(process.env.TMPDIR ?? os.tmpdir(), "model-fallback-config-"),
  );
  const directory = path.join(home, ".config", "opencode");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "opencode.json"),
    JSON.stringify({ plugins: ["@kingychiu/opencode-model-fallback"] }),
  );

  await updateFallbackOptions({ mappings: { "a/one": "b/two" } }, { home, env: {} });
  const config = parse(await readFile(path.join(directory, "opencode.json"), "utf8"));
  expect(config.plugins[0]).toEqual({
    package: "@kingychiu/opencode-model-fallback",
    options: { mappings: { "a/one": "b/two" } },
  });
});
