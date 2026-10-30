/**
 * On GitHub Actions, print test failures in the TypeScript-compiler line format so the problem
 * matcher that actions/setup-node registers turns them into annotations. (Plain `::error` workflow
 * commands don't work here because `pnpm -r` prefixes every output line.) No-op elsewhere.
 */
import type { Reporter } from "vitest/reporters";

interface TaskLike {
  name: string;
  type?: string;
  mode?: string;
  tasks?: TaskLike[];
  result?: { state?: string; errors?: Array<{ message?: string; stack?: string }> };
  file?: { filepath?: string; name?: string };
  filepath?: string;
  location?: { line: number; column: number };
}

const oneLine = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s*\n\s*/g, " ⏎ ").slice(0, 2500);

export default class CiAnnotationsReporter implements Reporter {
  onFinished(files: unknown[] = [], errors: unknown[] = []) {
    if (!process.env.GITHUB_ACTIONS) return;
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const failures: string[] = [];
    const walk = (t: TaskLike, path: string[], file: string) => {
      if (t.tasks) {
        if (t.result?.state === "fail" && t.result.errors?.length) {
          const e = t.result.errors[0];
          failures.push(`${file}(1,1): error TS9001: [suite ${[...path, t.name].join(" > ")}] ${oneLine(e?.stack ?? e?.message ?? "")}`);
        }
        for (const c of t.tasks) walk(c, [...path, t.name], file);
        return;
      }
      if (t.mode === "skip" || t.mode === "todo" || t.result?.state === "skip") skipped++;
      else if (t.result?.state === "pass") passed++;
      else if (t.result?.state === "fail") {
        failed++;
        const e = t.result.errors?.[0];
        const line = t.location?.line ?? 1;
        failures.push(`${file}(${line},1): error TS9001: [${[...path, t.name].join(" > ")}] ${oneLine(e?.stack ?? e?.message ?? "")}`);
      }
    };
    for (const f of files as TaskLike[]) {
      const file = (f.filepath ?? f.name ?? "unknown").replace(/^.*\/apps\/api\//, "apps/api/");
      for (const c of f.tasks ?? []) walk(c, [], file);
      if (f.result?.state === "fail" && f.result.errors?.length) {
        failures.push(`${file}(1,1): error TS9001: [file] ${oneLine(f.result.errors[0]?.stack ?? f.result.errors[0]?.message ?? "")}`);
      }
    }
    for (const e of errors as Array<{ message?: string; stack?: string }>) {
      failures.push(`apps/api/vitest(1,1): error TS9001: [unhandled] ${oneLine(e?.stack ?? e?.message ?? String(e))}`);
    }
    // Distinct line numbers so GitHub does not fold annotations together.
    failures.slice(0, 9).forEach((line, i) => console.log(line.replace(/\((\d+),1\): error/, `(${i + 2},1): error`)));
    console.log(`apps/api/vitest-summary(900,1): warning TS9000: vitest summary: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  }
}
