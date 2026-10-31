// 把 packages/shared 的协议类型同步到 App 内,让 Metro 只处理项目内的文件。
// 单一真相仍在 packages/shared,改完那边跑一次 pnpm sync:protocol。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "../../packages/shared/src");
const destDir = path.resolve(here, "../src/shared");

fs.mkdirSync(destDir, { recursive: true });

const files = ["protocol.ts", "api-types.ts", "shell.ts", "user-content.ts"];
const banner =
  "// 由 mobile/scripts/sync-protocol.mjs 从 packages/shared/src 生成,请勿手改。\n";

for (const file of files) {
  const from = path.join(srcDir, file);
  const to = path.join(destDir, file);
  const body = fs.readFileSync(from, "utf8");
  fs.writeFileSync(to, banner + body, "utf8");
  console.log(`已同步 ${file}`);
}

fs.writeFileSync(
  path.join(destDir, "index.ts"),
  banner + 'export * from "./protocol.ts";\nexport * from "./api-types.ts";\nexport * from "./shell.ts";\nexport * from "./user-content.ts";\n',
  "utf8",
);
console.log("已同步 index.ts");
