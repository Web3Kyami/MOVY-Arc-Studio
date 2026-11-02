/**
 * Forces the node to be unreachable and checks that the user sees something
 * actionable instead of a JSON-RPC dump.
 *
 * The reported symptom was a wall of viem internals ending in "Failed to fetch".
 * This makes sure a dropped connection now produces a sentence a person can act
 * on, with a retry, and no raw RPC detail.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const OUT = process.env.SHOT_OUT || "C:/Users/USER/Desktop/MOVY/evidence/connected";
const CHAIN_ID = "0x4cef52";
const ACCOUNT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

mkdirSync(OUT, { recursive: true });

/** Wallet that works, but every RPC read is aborted, like a dropped connection. */
const STUB = ({ account, chainId }) => {
  const provider = {
    isMetaMask: true,
    async request({ method }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account];
        case "eth_chainId":
          return chainId;
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
        case "wallet_requestPermissions":
          return null;
        default:
          // Exactly the failure mode viem surfaces as "Failed to fetch".
          throw new TypeError("Failed to fetch");
      }
    },
    on() { return provider; },
    removeListener() { return provider; },
  };
  window.ethereum = provider;
};

const problems = [];
const notes = [];

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
await context.addInitScript(STUB, { account: ACCOUNT, chainId: CHAIN_ID });
const page = await context.newPage();

await page.goto("http://localhost:3111/activity", { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /Connect Injected/i }).first().click().catch(() => {});
// retries are 1s then 2s, so give the failure path time to surface
await page.waitForTimeout(9000);

const text = await page.innerText("body");

if (/Could not reach Arc Testnet/.test(text)) notes.push('says "Could not reach Arc Testnet"');
else problems.push(`no friendly offline title; body was ${JSON.stringify(text.slice(0, 300))}`);

if (/Try again/.test(text)) notes.push("offers a Try again button");
else problems.push("no retry button");

const leaks = [
  "Raw Call Arguments",
  "Request body",
  "Contract Call",
  "Failed to fetch",
  "viem.sh/docs",
  "URL: https://",
  "0xfc0a597c",
];
for (const leak of leaks) {
  if (text.includes(leak)) problems.push(`raw RPC detail leaked into the UI: ${JSON.stringify(leak)}`);
  else notes.push(`no raw detail: ${leak}`);
}

await page.screenshot({ path: `${OUT}/error-offline-375.png`, fullPage: true });

console.log("NOTES:");
for (const n of notes) console.log("  " + n);
if (problems.length) {
  console.log("\nPROBLEMS:");
  for (const p of problems) console.log("  " + p);
  process.exitCode = 1;
} else {
  console.log("\nPASS: a dropped connection produces an actionable message with no RPC internals.");
}
await browser.close();
