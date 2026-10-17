// Builds the static dashboard into docs/ (served by GitHub Pages).
// SITE_RPCS (JSON array) and SITE_OUT override the defaults, for testing against a local fork.
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

const rpcs = process.env.SITE_RPCS ? JSON.parse(process.env.SITE_RPCS) : ["https://base-rpc.publicnode.com", "https://mainnet.base.org"];
const out = process.env.SITE_OUT ?? "docs";

await mkdir(out, { recursive: true });
await build({
  entryPoints: ["site/app.js"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  outfile: `${out}/app.js`,
  define: { __RPCS__: JSON.stringify(rpcs) },
  legalComments: "none",
  logLevel: "info",
});
await cp("site/index.html", `${out}/index.html`);
await cp("site/style.css", `${out}/style.css`);
