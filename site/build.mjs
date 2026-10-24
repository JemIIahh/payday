// Builds the static dashboard into docs/ (served by GitHub Pages).
// SITE_RPCS (JSON array), SITE_INDEXER and SITE_OUT override the defaults, for testing against a local fork.
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";

const rpcs = process.env.SITE_RPCS ? JSON.parse(process.env.SITE_RPCS) : ["https://base-rpc.publicnode.com", "https://mainnet.base.org"];
const indexer = process.env.SITE_INDEXER ?? "https://indexer.hyperindex.xyz/53b7e25/v1/graphql";
const out = process.env.SITE_OUT ?? "docs";

await mkdir(out, { recursive: true });
await build({
  entryPoints: ["site/app.js"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  outfile: `${out}/app.js`,
  define: { __RPCS__: JSON.stringify(rpcs), __INDEXER__: JSON.stringify(indexer) },
  legalComments: "none",
  logLevel: "info",
});
await cp("site/index.html", `${out}/index.html`);
await cp("site/style.css", `${out}/style.css`);
await cp("site/og.png", `${out}/og.png`);
