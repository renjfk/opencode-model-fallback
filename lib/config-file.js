import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";

async function configPath(env, home) {
  const directory = path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "opencode");
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const candidate = path.join(directory, name);
    try {
      return { path: candidate, source: await readFile(candidate, "utf8") };
    } catch {}
  }
  throw new Error("Global opencode.jsonc or opencode.json was not found");
}

function pluginIndex(config) {
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  return plugins.findIndex((plugin) => {
    const name = typeof plugin === "string" ? plugin : plugin?.package;
    return typeof name === "string" && name.includes("opencode-model-fallback");
  });
}

export async function updateFallbackOptions(patch, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const file = await configPath(env, home);
  const errors = [];
  const config = parse(file.source, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error("The global OpenCode configuration is not valid JSONC");
  const index = pluginIndex(config);
  if (index < 0)
    throw new Error("The model-fallback plugin is not in the global OpenCode configuration");

  const plugin = config.plugins[index];
  if (typeof plugin === "string") {
    const edits = modify(
      file.source,
      ["plugins", index],
      { package: plugin, options: patch },
      { formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" } },
    );
    const updated = applyEdits(file.source, edits);
    await writeFile(file.path, updated);
    return file.path;
  }

  let source = file.source;
  for (const [key, value] of Object.entries(patch)) {
    const edits = modify(source, ["plugins", index, "options", key], value, {
      formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" },
    });
    source = applyEdits(source, edits);
  }
  await writeFile(file.path, source);
  return file.path;
}
