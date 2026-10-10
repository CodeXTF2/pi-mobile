// Register (or remove) the Pi Mobile extension in the user's pi settings
// so it loads in every pi session. All code stays in THIS folder; only a single
// path reference is added to ~/.pi/agent/settings.json. Reversible with --remove.
//
//   node install.mjs            # install
//   node install.mjs --remove   # uninstall
//   node install.mjs --agent-dir "C:\\path\\to\\.pi\\agent"   # custom agent dir

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.join(HERE, "extension", "index.ts");

const argv = process.argv.slice(2);
const remove = argv.includes("--remove") || argv.includes("--uninstall");
const adIdx = argv.indexOf("--agent-dir");
const agentDir = adIdx >= 0 ? argv[adIdx + 1] : path.join(os.homedir(), ".pi", "agent");
const settingsPath = path.join(agentDir, "settings.json");

fs.mkdirSync(agentDir, { recursive: true });

let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    fs.copyFileSync(settingsPath, settingsPath + ".bak");
  } catch (e) {
    console.error(`Could not parse ${settingsPath}: ${e.message}`);
    process.exit(1);
  }
}

if (!Array.isArray(settings.extensions)) settings.extensions = [];

const norm = (p) => path.resolve(p).toLowerCase();
const already = settings.extensions.find((e) => norm(e) === norm(EXT_PATH));

if (remove) {
  if (!already) {
    console.log("Pi Mobile was not installed in settings. Nothing to do.");
  } else {
    settings.extensions = settings.extensions.filter((e) => norm(e) !== norm(EXT_PATH));
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`Removed from ${settingsPath}.`);
  }
} else {
  if (already) {
    console.log(`Already installed in ${settingsPath}.`);
  } else {
    settings.extensions.push(EXT_PATH);
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`Installed Pi Mobile.`);
    console.log(`  settings: ${settingsPath}`);
    console.log(`  extension: ${EXT_PATH}`);
  }
  console.log(`\nNext: start (or restart) a pi session, then run /mobileauth to pair your phone.`);
}
