import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
const serverRoot = path.resolve(import.meta.dirname, "..");
const dataDir = path.resolve(process.env.REMOTE_CC_DATA_DIR || path.join(serverRoot, "data"));
const listDir = path.resolve(process.env.REMOTE_CC_LIST_DIR || path.join(dataDir, "list"));
const paths = (key: string) => (process.env[key] || "").split(";").map(p => p.trim()).filter(Boolean).map(p => path.resolve(p));
let rootsCache: { at: number; value: string[] } | null = null;
function roots() {
  if (!rootsCache || Date.now() - rootsCache.at > 5000) {
    // Whole-drive browsing is an explicit local profile, never a public default.
    const configured = paths("REMOTE_CC_ROOTS");
    rootsCache = { at: Date.now(), value: [...new Set([...configured.filter(p => fs.existsSync(p)), listDir])] };
  }
  return rootsCache.value;
}
export const config = {
  version: "1.0.0",
  port: Number(process.env.REMOTE_CC_PORT || 8787),
  listenHost: process.env.REMOTE_CC_LISTEN_HOST || "127.0.0.1",
  dataDir, listDir,
  uploadsDir: path.join(listDir, "uploads"), exportsDir: path.join(listDir, "exports"),
  attachmentsDir: path.join(listDir, "attachments"), mailDir: path.join(listDir, "mail"),
  releasesDir: path.join(dataDir, "releases"),
  publicUrl: (process.env.REMOTE_CC_PUBLIC_URL || "").replace(/\/+$/, ""),
  features: {
    accounts: process.env.REMOTE_CC_ENABLE_ACCOUNTS === "1",
    elevation: process.env.REMOTE_CC_ENABLE_ELEVATION === "1",
    webdav: process.env.REMOTE_CC_ENABLE_WEBDAV === "1",
    legacyCli: process.env.REMOTE_CC_ENABLE_LEGACY_CLI === "1",
  },
  get roots() { return roots(); },
  get readOnlyRoots() { return paths("REMOTE_CC_READONLY_ROOTS"); },
  get fullRoots() { return paths("REMOTE_CC_FULL_ROOTS"); },
  upstream: { ccSwitchPort: Number(process.env.REMOTE_CC_CCSWITCH_PORT || 15721), mihomoPort: Number(process.env.REMOTE_CC_PROXY_PORT || 7897) },
  claudeProjectsDir: process.env.REMOTE_CC_CLAUDE_PROJECTS_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects"),
};
