import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:3111";
const OUT = "./evidence/initial_inspection";
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "375", width: 375, height: 812 },
  { name: "1280", width: 1280, height: 900 },
];

const ROUTES = [
  "/",
  "/home",
  "/activity",
  "/savings",
  "/settings",
];

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
});

const report = {};

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
  });
  report[vp.name] = {};

  for (const route of ROUTES) {
    const page = await context.newPage();
    await page.goto(BASE + route, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);

    const slug = route === "/" ? "landing" : route.replace("/", "");
    const shotPath = `${OUT}/${slug}-${vp.name}.png`;
    await page.screenshot({ path: shotPath, fullPage: false });

    const text = await page.innerText("body");
    const testnetMatches = text.match(/testnet|5042002|faucet|vault|erc-20|relayer|contract/gi) || [];

    report[vp.name][route] = {
      title: await page.title(),
      h1: await page.locator("h1").allInnerTexts(),
      testnetKeywords: Array.from(new Set(testnetMatches.map(s => s.toLowerCase()))),
      shotPath,
    };

    await page.close();
  }
  await context.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 2));
