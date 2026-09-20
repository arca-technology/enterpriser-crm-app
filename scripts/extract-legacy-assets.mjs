import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = await readFile(path.join(root, "index.html"), "utf8");
const configSource = await readFile(path.join(root, "config.js"), "utf8");
const styles = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
const body = html.match(/<body>([\s\S]*?)<script src="config\.js"><\/script>/)?.[1];

if (!styles || !body) {
  throw new Error("Nao foi possivel extrair o CSS ou o corpo do CRM legado.");
}

const markup = body.replace(/\s*<script src="app\.js"><\/script>\s*<\/body>[\s\S]*$/, "").trim();
const notice = "/* Gerado por npm run sync:legacy a partir de index.html. */\n";
const sandbox = { window: {} };
vm.runInNewContext(configSource, sandbox, { filename: "config.js" });

if (!sandbox.window.CRM_CONFIG) {
  throw new Error("Nao foi possivel extrair a configuracao do CRM.");
}

await mkdir(path.join(root, "public", "legacy"), { recursive: true });
await writeFile(
  path.join(root, "app", "globals.css"),
  `${notice}${styles.trim()}\n\n#legacy-root { display: contents; }\n`,
);
await writeFile(
  path.join(root, "components", "legacy-markup.ts"),
  `/* Gerado por npm run sync:legacy a partir de index.html. */\nexport const legacyMarkup = ${JSON.stringify(markup)};\n`,
);
await writeFile(
  path.join(root, "components", "legacy-config.ts"),
  `/* Gerado por npm run sync:legacy a partir de config.js. */\nexport const legacyConfig = ${JSON.stringify(sandbox.window.CRM_CONFIG, null, 2)} as const;\n`,
);
await copyFile(path.join(root, "app.js"), path.join(root, "public", "legacy", "app.js"));
await copyFile(path.join(root, "config.js"), path.join(root, "public", "legacy", "config.js"));
await copyFile(path.join(root, "privacy-policy.html"), path.join(root, "public", "privacy-policy.html"));
