// Renders site/og.html to site/og.png (the 1200x630 social card). Needs Playwright with Chromium:
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs node site/og.mjs
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(new URL("./og.html", import.meta.url).href, { waitUntil: "networkidle" });
await page.screenshot({ path: new URL("./og.png", import.meta.url).pathname });
await browser.close();
