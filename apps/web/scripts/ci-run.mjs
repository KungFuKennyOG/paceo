#!/usr/bin/env node
/**
 * Runs a command and, on GitHub Actions, turns a failure into an error annotation holding the tail
 * of the output (job logs are not always reachable, annotations are). Locally it is a plain passthrough.
 * Usage: node scripts/ci-run.mjs <label> <command> [...args]
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const [label, cmd, ...args] = process.argv.slice(2);
if (!label || !cmd) {
  console.error("usage: ci-run.mjs <label> <command> [...args]");
  process.exit(2);
}
const inCi = process.env.GITHUB_ACTIONS === "true";
const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");
// eslint-disable-next-line no-control-regex
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"], shell: process.platform === "win32" });
let out = "";
const keep = (chunk, stream) => {
  stream.write(chunk);
  out += chunk.toString();
  if (out.length > 200_000) out = out.slice(-100_000);
};
child.stdout.on("data", (c) => keep(c, process.stdout));
child.stderr.on("data", (c) => keep(c, process.stderr));
child.on("close", (code) => {
  if (inCi && code !== 0) {
    const lines = strip(out).split("\n").filter((l) => l.trim());
    const errorLines = lines.filter((l) => /error|fail|×|✗|FAIL|Error:|expected|received/i.test(l)).slice(0, 80);
    const tail = lines.slice(-60);
    console.log(`::error title=${label} failed (exit ${code})::${esc([...errorLines, "---- tail ----", ...tail].join("\n").slice(0, 60_000))}`);
  }
  if (inCi && code === 0 && label === "web build") {
    const v = (name) => {
      try {
        return JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8")).version;
      } catch {
        return "?";
      }
    };
    const names = ["vite", "vitest", "react", "react-router", "@tanstack/react-query", "vite-plugin-pwa", "@vitejs/plugin-react", "typescript", "jsdom"];
    console.log(`::notice title=web versions::${names.map((n) => `${n}@${v(n)}`).join(", ")}`);
  }
  process.exit(code ?? 1);
});
