# MOVY

**Spend normally. Save naturally. Move forward with MOVY.**

MOVY is a self-custodial savings experience built on **Arc** that turns spare change from eligible USDC payments into progress toward personal goals.

Our idea is simple: saving shouldn't always require another decision. MOVY brings automatic round-ups, savings goals, and wallet-controlled permissions together in an experience designed for everyday life.

Connected profile names and photos are stored by wallet address and can be viewed by anyone who knows the address. Profile updates require a wallet signature. Run the PostgreSQL migrations before using connected profiles. RainbowKit mobile and QR connections use `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID`.

## Explore MOVY

- **App:** [MOVY](https://movy-web3kyamis-projects.vercel.app)
The product opens on the landing page. Start Saving opens wallet onboarding, followed by the connected Home screen.
MOVY selects one Arc network per deployment. Production uses Arc Mainnet (`5042`); the default local environment uses Testnet (`5042002`).

## How to use MOVY

Connect to the Arc network selected for the deployment. Set up savings in three screens:

Returning wallets with a saved profile or prior savings enrollment open Home after connecting.

1. **Connect your spending wallet.** This is the wallet you use for eligible direct USDC payments on Arc. The merchant still receives your original payment.
2. **Choose your name and savings address.** Enter a different wallet address that you control. Round-ups go there, not back to your spending wallet. Never enter a recovery phrase or private key.
3. **Set your limits and turn on automatic saving.** The daily limit caps round-ups per UTC day. The total USDC allowance sets how much MOVY may transfer over time. Your wallet confirms enrollment and the allowance separately. Network fees may apply; check the network shown in your wallet before confirming.

After an eligible payment is confirmed, MOVY attempts a separate round-up from the spending wallet to your savings address, subject to your daily limit and remaining allowance. MOVY does not change the merchant's payment or take custody of your spending funds. You can pause automatic saving or revoke permissions.

**Current payment scope:** supported direct USDC transfers on Arc. Card spending, swaps, other tokens, and arbitrary contract interactions are not covered by this integration.

## Built for real financial habits

- **Automatic round-ups:** small, consistent savings opportunities tied to eligible payments.
- **Savings goals:** organize progress around an emergency fund, a purchase, education, or other priorities.
- **Activity and insights:** follow payments and savings activity from one clear interface.
- **User control:** self-custodial destinations, explicit wallet approvals, transaction limits, daily caps, pause and revocation.
- **Familiar experience:** straightforward onboarding and dashboards without unnecessary blockchain complexity.

## Built on Arc

Arc and USDC help us make savings understandable in dollar terms while using on-chain permissions and verifiable transactions behind the scenes.

### Arc Mainnet contracts

The latest AutoSaver was deployed from the owner wallet through MetaMask and verified against the reviewed source on two RPC providers. The existing Savings Vault matches current source and is reused. The local Testnet verification below remains a separate application run.

| Component | Address |
| --- | --- |
| Chain ID | `5042` |
| USDC | `0x3600000000000000000000000000000000000000` |
| MOVY AutoSaver | [`0x98ab14da8f6e68add0cdfeb75bdc4c2ea9044539`](https://explorer.arc.io/address/0x98ab14da8f6e68add0cdfeb75bdc4c2ea9044539) |
| MOVY Savings Vault | [`0xFc194011A769e90D93B51Dd9507d69dfc4681164`](https://explorer.arc.io/address/0xFc194011A769e90D93B51Dd9507d69dfc4681164) |

Deployment transactions:
[AutoSaver](https://explorer.arc.io/tx/0x4c1f8c9f29754bb046f49fbb0a9606263f7b4b1f4f990d8ee725b166b302354c) ·
[Savings Vault](https://explorer.arc.io/tx/0x135c0543f9f0bb33682c1b7f2a8c204cbbe768db892e4a57fe7f2d9daf40c826)

The previous AutoSaver at `0xdFC85c553E651Ce4B8F2daF4915f205CdbEA5525` is a historical deployment. The latest deployment includes the allowance-view pause fix.

## Architecture

MOVY is built with **Next.js, React, TypeScript, wagmi, viem, Solidity, PostgreSQL, and Foundry**.

RainbowKit powers the product wallet chooser. It opens a list of supported wallet apps, including Rainbow, MetaMask and WalletConnect. Set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` using a free [WalletConnect Cloud](https://cloud.walletconnect.com/) project to enable QR and mobile wallet connections.

The application combines a wallet-connected product interface, an on-chain payment observer, durable payment and round-up records, and an authorized relayer that interacts with the AutoSaver smart contract. The contract enforces user-configured allowances and caps, and backend processing includes safeguards against duplicate execution and uncertain transactions.

## Development with Arc Studio

MOVY's existing codebase was imported into [Arc Studio](https://studio.arc.io/app/303b83d4-ba20-46ff-a3de-93e5f83d73a8). Studio contributed contract pause reporting, Foundry regression tests, connected-app service status, and relayer pause safeguards. Local review adds wallet-hook and stale-cache checks, plus payout verification that requires a finalized canonical `RoundupExecuted` event matching the payment, wallet, destination, and amounts before a roundup is confirmed.

The personal saving setting stays separate from service availability. A service pause preserves pending round-ups and does not change the user's permission.

On November 1, 2026, Studio completed TypeScript, WalletConnect connector, financial presentation, AutoSaver write safety, and withdrawal fee policy checks with exit code zero. These checks cover source behavior; real phone pairing and browser signing remain unverified.

For Mainnet release preparation, [Arc Studio](https://studio.arc.io/app/303b83d4-ba20-46ff-a3de-93e5f83d73a8) implemented fee-limit validation and a source lock that binds the release manifest to the reviewed contract code. It also added ten Solidity readiness tests covering owner/relayer separation, global pause, and six-decimal USDC accounting. The resulting 89-test contract suite passed in Studio and locally. Mainnet signing and deployment are separate from these source checks.

## Arc Testnet verification

On October 31, 2026, the local Testnet app completed a controlled end-to-end flow against AutoSaver [`0xfefad1873cf3908887b7f3bc452b701baf3c9703`](https://testnet.arcscan.app/address/0xfefad1873cf3908887b7f3bc452b701baf3c9703) on chain `5042002`. An enrolled test wallet paid `$0.17` directly to a merchant; MOVY observed the finalized payment and its relayer transferred `$0.83` to the selected savings wallet. The test enrollment was then paused and revoked, and its USDC allowance is zero.

- [Test payment](https://testnet.arcscan.app/tx/0xe11a583c50b555fb1307831c21364d50b119de872824bd6f1f1a614d42cc6d66)
- [Confirmed savings transfer](https://testnet.arcscan.app/tx/0xec7d06078123147d4e895f3f7da5e9e0ffcd8357586c379a2e7b2f795f6e673e)
- [Testnet certification details and checks](docs/TESTNET-FIRST-FINANCIAL-CERTIFICATION.md)

The chain, observer, local database and relayer path were exercised with existing test wallets. The Settings picker offers MetaMask, Rabby and WalletConnect when the public project identifier is configured. Chromium opened the desktop QR modal and mobile wallet list. Pairing with a real phone wallet and signing through the browser remain unverified.

The recorded verification also includes 79 Arc Foundry contract tests with 5,000 fuzz runs, isolated PostgreSQL integration suites, and a 119-check read-only browser audit at mobile and desktop sizes. The browser audit used an in-memory wallet provider and did not sign or broadcast transactions. See the [full Testnet certification](docs/TESTNET-FIRST-FINANCIAL-CERTIFICATION.md) for its scope and evidence. This does not certify a Mainnet release.

## Development

Requires Node.js 24 and npm. PostgreSQL 17 is used for database-backed functionality.

```bash
npm ci
npm run dev
```

Before deploying a connected production environment, use the verified deployment manifest at `config/networks/arc-mainnet.json` and configure the network-bound PostgreSQL database, RPC endpoints, origin allowlists, and authenticated operations. Keep signing keys and credentials out of source control and public application runtimes.

Technical documentation: [Mainnet operations](docs/MOVY-MAINNET-CUTOVER.md) · [Worker operations](docs/WORKER-OPERATIONS.md) · [Release readiness](docs/RELEASE-READINESS.md)

## Our vision

We believe financial progress should feel achievable, even when the amounts are small. MOVY is our step toward making saving a natural part of the payments people already make.

**Spend normally. Save naturally. Move forward with MOVY.**

## License

MIT — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
