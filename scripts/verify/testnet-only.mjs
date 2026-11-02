import { mkdirSync } from "node:fs";
import { launchChromium } from "./browser-runtime.mjs";

const BASE = process.env.SHOT_BASE || "http://localhost:3111";
const OUT = process.env.SHOT_OUT || process.env.EVIDENCE_OUT || "./evidence/connected";
mkdirSync(OUT, { recursive: true });

const problems = [];
const notes = [];

/** Wallet stub that reports a chain the app is not targeting. */
const STUB = ({ account, chainId }) => {
  let switched = null;
  window.__walletMethods = [];
  const provider = {
    isMetaMask: true,
    async request({ method, params = [] }) {
      window.__walletMethods.push(method);
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account];
        case "eth_chainId":
          return switched ?? chainId;
        case "wallet_switchEthereumChain": {
          const target = params[0]?.chainId;
          // A real wallet switches; this one reports the new chain afterwards.
          switched = target;
          window.__switchedTo = target;
          return null;
        }
        case "wallet_addEthereumChain":
        case "wallet_requestPermissions":
          return null;
        default:
          return null;
      }
    },
    on() { return provider; },
    removeListener() { return provider; },
  };
  window.ethereum = provider;
};

const browser = await launchChromium();
const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 2 });
// 1 = Ethereum mainnet, a chain the app does not target.
await context.addInitScript(STUB, {
  account: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  chainId: "0x1",
});
const page = await context.newPage();

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const landing = await page.innerText("body");
if (/Explore Demo/.test(landing)) problems.push("product landing must not offer a Demo entry point");
else notes.push("product landing keeps the wallet-connected journey as its entry point");
if (/TESTNET|Testnet only|mainnet|Preview|Simulated/i.test(landing)) problems.push("consumer landing exposes engineering or preview language");
else notes.push("consumer landing keeps engineering details off the public entry screen");
await page.screenshot({ path: `${OUT}/landing-375.png`, fullPage: true });
await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

await page.getByRole("button", { name: "Connect wallet", exact: true }).first().click();
const chooseWallet = page.getByRole("button", { name: "Choose wallet", exact: true }).first();
if (await chooseWallet.count()) {
  await chooseWallet.click();
  await page.getByRole("button", { name: /MetaMask|Injected/i }).first().click();
} else {
  await page.getByRole("button", { name: /Connect Injected|Connect MetaMask/i }).first().click();
}
await page.waitForTimeout(3000);

const wrong = await page.innerText("body");
if (/Switch network/.test(wrong)) notes.push("wrong-network state offers the network switch action in Settings");
else problems.push(`wrong-network state unclear: ${JSON.stringify(wrong.slice(0, 200))}`);
if (/mainnet/i.test(wrong)) problems.push("wrong-network consumer state mentions Mainnet");
await page.screenshot({ path: `${OUT}/wrong-network-375.png`, fullPage: true });

// Click the switch button and confirm the app asks for chain 5042002 = 0x4cef52
const sw = page.getByRole("button", { name: /Switch network/i }).first();
if (await sw.count()) {
  await sw.click();
  await page.waitForTimeout(2500);
  const switchedTo = await page.evaluate(() => window.__switchedTo ?? null);
  if (switchedTo === "0x4cef52") notes.push("switch button requests chain 5042002 (0x4cef52)");
  else problems.push(`switch requested ${switchedTo}, expected 0x4cef52`);
} else {
  problems.push("no switch button on the wrong-network screen");
}
const forbiddenReads = await page.evaluate(() => window.__walletMethods.filter((method) =>
  ["eth_call", "eth_getBalance", "eth_getCode", "eth_getTransactionReceipt"].includes(method),
));
if (forbiddenReads.length) problems.push(`wrong-network wallet attempted chain reads: ${forbiddenReads.join(", ")}`);
else notes.push("wrong-network state did not make financial or contract reads");

await browser.close();
console.log("NOTES:");
for (const n of notes) console.log("  " + n);
if (problems.length) {
  console.log("\nPROBLEMS:");
  for (const p of problems) console.log("  " + p);
  process.exitCode = 1;
} else {
  console.log("\nPASS: consumer copy and Arc Testnet wrong-network handling verified.");
}
