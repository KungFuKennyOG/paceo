// Bundles the API (and the workspace packages it imports, which ship as TypeScript source) into
// dist/. npm dependencies stay external and are installed in the runtime image.
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

/** Keep every bare import external except our own workspace packages. */
const externalizeDeps = {
  name: "externalize-deps",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@paceo/")) return undefined;
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: ["src/main.ts", "src/cli/create-invite.ts", "src/cli/migrate.ts", "src/cli/vapid-keys.ts"],
  outdir: "dist",
  outbase: "src",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  logLevel: "info",
  plugins: [externalizeDeps],
});
