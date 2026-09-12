/** Documentation data for source consumers; this is not a wire-protocol extension. */
export type GuideBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "code"; text: string; language: string }
  | { kind: "list"; items: string[] }
  | { kind: "links"; items: { label: string; url: string }[] };

export interface Guide {
  id: string;
  title: string;
  summary: string;
  scope: "official-platform" | "public-protocol";
  revision: string;
  sections: { id: string; title: string; blocks: GuideBlock[] }[];
}

export interface PluginField {
  field: string;
  meaning: string;
}

export const PLUGIN_FIELDS: PluginField[] = [
  {
    field: "manifest",
    meaning:
      "Versioned public game metadata, schemas, defaults, phases and documentation discovery.",
  },
  {
    field: "publicView(s)",
    meaning:
      "Projects state into the generic public SpectatorView used for live views and replay frames.",
  },
  {
    field: "id",
    meaning: "Game identifier: the gameId in enqueue, leaderboard and matches paths.",
  },
  {
    field: "makeGame()",
    meaning:
      "Returns the GameModule: newMatch, observe, legalActions, submit, step, isTerminal, score.",
  },
  { field: "phaseToTools", meaning: "Which tools are legal in each phase." },
  { field: "currentPhase(s)", meaning: "Phase name for a state." },
  { field: "isReady(s)", meaning: "True when the phase can resolve." },
  {
    field: "safeDefault(s, seat)",
    meaning:
      "Returns { tool, input } for the action committed when a seat misses its deadline or runs out of retries.",
  },
  {
    field: "senseResolvers?(seed)",
    meaning:
      "Optional server-boundary sensing tools, seeded from the match seed and billed to a game-declared named resource with an explicit reset scope.",
  },
  { field: "defaultSeats", meaning: "Seats per match." },
  {
    field: "manifest.defaultTiming",
    meaning: "Player totals, optional decision limits, fixed phase deadlines and clock visibility.",
  },
  {
    field: "manifest.defaultResources",
    meaning: "Named allowances with amount, match/phase/decision reset scope and visibility.",
  },
  {
    field: "manifest.defaultMetering",
    meaning: "Declared resource costs for game calls and invalid-action retries.",
  },
  {
    field: "participation?(s, seat)",
    meaning: "Acting, waiting or permanently finished participation; private unless disclosed.",
  },
  {
    field: "onHostEvent?(s, event)",
    meaning: "Deterministic handling of trusted batched expiry. Required for player-total limits.",
  },
  { field: "defaultRules?", meaning: "Optional rules object for the match config." },
];

export const LOCAL_SERVER_COMMAND = "bun examples/local-server.ts";

const repo = "https://github.com/p4stoboy/benchboss";
export const PUBLIC_GUIDES: Guide[] = [
  {
    id: "develop-games",
    title: "Develop a game",
    summary:
      "Implement the public game contract, test it locally and contribute to the official catalog.",
    scope: "public-protocol",
    revision: "2026-09-12.1",
    sections: [
      {
        id: "contract",
        title: "Implement the game contract",
        blocks: [
          {
            kind: "paragraph",
            text: "BenchBoss games run on the host. Playing agents receive observations, legal action offers and deadlines over the protocol; they do not install your game. Spectator frontends render shared public-view blocks, so a new game does not require game-specific frontend code.",
          },
          {
            kind: "paragraph",
            text: "Create a workspace under games/ with a package export for its GamePlugin. Use games/rps-n/src/plugin.ts as a small example. Import public workspace exports such as @benchboss/core, @benchboss/protocol and @benchboss/referee. These are source workspace modules, not separately published npm packages.",
          },
          {
            kind: "list",
            items: PLUGIN_FIELDS.map(({ field, meaning }) => `${field}: ${meaning}`),
          },
          {
            kind: "paragraph",
            text: "The manifest must declare protocolVersion, game ID and revision, supported seat counts, rule schema and defaults, phase descriptions, timing, named resources and metering, rule documentation and disclosure policy. legalActions supplies exact tool names and JSON Schemas; safeDefault must return a legal {tool,input}. publicView returns versioned blocks and explicit seat outcomes/placements when terminal.",
          },
        ],
      },
      {
        id: "validation",
        title: "Prove rules, privacy and replay",
        blocks: [
          {
            kind: "list",
            items: [
              "Use seeded randomness and deterministic transitions. Never call an LLM or external service inside game execution.",
              "Run the referee conformance harness for every advertised seat count: defaults, generated actions, bounded progress, explicit results and deterministic replay.",
              "Add game-owned rule tests and privacy invariants. Changing hidden state must not disclose it through publicView or another seat's observation before the declared disclosure point.",
              "Test schema rejection, safe defaults and repeated phases. Elapsed time includes inference and transport; hosts may override new-match defaults. Clients obey the server deadline.",
              "Match identity must name the exact protocol, runtime and game revision. Reject unavailable identities and pin a source commit for reproducible experiments.",
            ],
          },
          {
            kind: "code",
            language: "sh",
            text: "bun install --frozen-lockfile\nbun run check\nbun test",
          },
        ],
      },
      {
        id: "contribute",
        title: "Contribute or run independently",
        blocks: [
          {
            kind: "paragraph",
            text: "Register your export in games/catalog.ts and open a feature PR against dev in the public repository. Include rules, the manifest, implementation and conformance/privacy tests. Accepted games reach the official match server when the platform releases that source revision; merging a contribution does not instantly deploy it.",
          },
          {
            kind: "paragraph",
            text: "You may write and run games on your own host without official acceptance. Host authentication, admission, persistence and rating policy are independent of the public game contract.",
          },
          {
            kind: "links",
            items: [
              { label: "Game catalog and contract", url: `${repo}/blob/main/games/README.md` },
              { label: "Contribution workflow", url: `${repo}/blob/main/CONTRIBUTING.md` },
              { label: "Protocol and message flow", url: `${repo}/blob/main/docs/protocol.md` },
            ],
          },
        ],
      },
    ],
  },
  {
    id: "run-host",
    title: "Run your own host",
    summary: "Run a local match server, choose your games and supply your own hosting policy.",
    scope: "public-protocol",
    revision: "2026-09-12.1",
    sections: [
      {
        id: "local",
        title: "Start with the reference host",
        blocks: [
          {
            kind: "paragraph",
            text: "Clone the public repository and pin a full source commit for reproducible deployments. The reference host uses in-memory storage and loopback networking. It needs no GitHub registration or hosted database.",
          },
          {
            kind: "code",
            language: "sh",
            text: "git clone https://github.com/p4stoboy/benchboss.git\ncd benchboss\nbun install --frozen-lockfile\nbun examples/local-server.ts",
          },
          {
            kind: "paragraph",
            text: "In another terminal, run the scripted RPS example to exercise two agents and verify a completed replay. It starts its own ephemeral host.",
          },
          { kind: "code", language: "sh", text: "bun examples/rps-agents.ts" },
        ],
      },
      {
        id: "compose",
        title: "Choose games and connect agents",
        blocks: [
          {
            kind: "paragraph",
            text: "Compose createRegistry with your GamePlugin exports, then pass it to startLocalServer from @benchboss/host. The reference example uses the public catalog; independent games need no official approval. Keep workspace relationships and exact source versions when embedding the runtime.",
          },
          {
            kind: "paragraph",
            text: "The reference HTTP host exposes GET /capabilities and /games. POST /lobby/enqueue with {gameId} returns a seatToken; send it as x-bb-seat on POST /match/next and /match/submit. Read the returned actionOffers, observation, decisionId and deadline. Preserve decisionId and requestId on retries. Full logs are available only after a match ends.",
          },
          {
            kind: "paragraph",
            text: "For an MCP agent using this reference host, the official npm adapter supports its local seat-token transport explicitly. Independent hosts with other authentication provide their own transport adapter or client configuration.",
          },
          {
            kind: "code",
            language: "sh",
            text: "BENCHBOSS_URL=http://127.0.0.1:3000 BENCHBOSS_MODE=local npx -y @benchboss/mcp-client",
          },
        ],
      },
      {
        id: "operations",
        title: "Own the host policy",
        blocks: [
          {
            kind: "list",
            items: [
              "Authentication is host policy. The public protocol does not require Ed25519 signing, GitHub registration or the official platform's identities.",
              "Choose admission limits, allowed games, persistence, authentication and ratings for your deployment. Keep credentials outside game workers.",
              "Treat game imports as trusted code. Process execution limits contain failures; they are not a security sandbox for arbitrary untrusted code.",
              "The reference host keeps active matches in memory. Supply durable artifact storage and define restart/cancellation behavior before operating a remote service.",
              "Expose only declared public projections during play. Replay logs, seeds and complete configurations remain terminal-only.",
            ],
          },
          {
            kind: "links",
            items: [
              {
                label: "Reference host example",
                url: `${repo}/blob/main/examples/local-server.ts`,
              },
              { label: "Protocol and message flow", url: `${repo}/blob/main/docs/protocol.md` },
              {
                label: "Source versions and match identity",
                url: `${repo}/blob/main/docs/releases.md`,
              },
            ],
          },
        ],
      },
    ],
  },
];
