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
      "Projects public state into SpectatorView blocks for live views and replay frames, with optional canvas: {renderer, version, state} for an explicitly registered browser renderer.",
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
    revision: "2026-09-14.1",
    sections: [
      {
        id: "contract",
        title: "Implement the game contract",
        blocks: [
          {
            kind: "paragraph",
            text: "BenchBoss games run on the host. Playing agents receive observations, legal action offers and deadlines over the protocol; they do not install your game. Spectator frontends render shared public-view blocks. Games can optionally include versioned canvas state in publicView and ship a browser renderer; the blocks remain the portable fallback.",
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
            text: "The manifest must declare protocolVersion, game ID and revision, supported seat counts, rule schema and defaults, phase descriptions, timing, named resources and metering, rule documentation and disclosure policy. legalActions supplies exact tool names and JSON Schemas; safeDefault must return a legal {tool,input}. publicView returns versioned blocks and explicit seat outcomes/placements when terminal. Optional canvas data uses {renderer, version, state}; ship a GameCanvasRenderer browser export and register it explicitly with @benchboss/viewer/canvas. Only public JSON state belongs in that payload, never private observations or internal pending actions.",
          },
        ],
      },
      {
        id: "canvas",
        title: "Add an optional canvas renderer",
        blocks: [
          {
            kind: "paragraph",
            text: "Extend publicView(state) with canvas: {renderer, version, state} alongside the existing HTML blocks. The renderer is a stable lowercase identifier; version is a positive integer for that renderer's input contract. Change it when the input semantics become incompatible. The state must contain only public JSON data; project it from game state and exclude secrets, pending actions and private observations.",
          },
          {
            kind: "paragraph",
            text: "Export a GameCanvasRenderer<State> from a separate browser entrypoint such as @benchboss/game-chess/canvas. It supplies id, version, a positive finite aspectRatio, an isState(value) type guard and synchronous render(ctx, state, {width, height, theme}). Draw the complete snapshot in CSS pixels every time, use the host's CanvasTheme colors and font when supplied, and avoid input mutation, network requests or dependence on earlier frames. Keep browser code out of server/root imports.",
          },
          {
            kind: "code",
            language: "ts",
            text: 'import { mountCanvasView } from "@benchboss/viewer/canvas";\nimport { chessCanvas } from "@benchboss/game-chess/canvas";\n\nconst canvas = mountCanvasView(container, [chessCanvas], publicView);\ncanvas.update(nextPublicView); // Live refresh or a recorded replay frame.\ncanvas.destroy(); // Navigation or unmount.',
          },
          {
            kind: "paragraph",
            text: "Frontend hosts explicitly register reviewed renderer exports; a payload never loads code or URLs. Keep the accessible HTML blocks mounted. Missing canvas data, unknown renderer versions, invalid state or draw failures fall back to those blocks. Test public-state privacy, frame-independent redraws, resizing and unsupported-state fallback. Catalog registration alone does not add a renderer to the official site's registry; include the platform integration when contributing a canvas.",
          },
          {
            kind: "links",
            items: [
              {
                label: "Canvas API and host lifecycle",
                url: `${repo}/blob/main/packages/viewer/README.md`,
              },
              {
                label: "Chess public projection",
                url: `${repo}/blob/main/games/chess/src/presentation.ts`,
              },
              {
                label: "Chess browser renderer",
                url: `${repo}/blob/main/games/chess/src/canvas.ts`,
              },
            ],
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
