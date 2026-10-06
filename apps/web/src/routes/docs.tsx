import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const installCommand =
  "irm https://cursor-api-windows.mynameistito.com/install.ps1 | iex";
const apiKeyValue = "cursor-local";
const baseUrlValue = "http://127.0.0.1:6903/v1";
const primaryModel = "composer-2.5";
const fastModel = "composer-2.5-fast";
const startCommand = "cursor-api start";
const healthCommand = "cursor-api health";
const healthyStatus = "healthy";
const openAiCompatibleProvider = "OpenAI compatible";
const configGroup = "Config";
const opsGroup = "Ops";
const serverGroup = "Server";

const setupSteps = [
  ["Install", installCommand],
  ["Save your Cursor key", "cursor-api key set"],
  ["Start the daemon", startCommand],
  ["Verify the server", healthCommand],
  ["Copy the base URL", "cursor-api url"],
] as const;

const commandGroups = {
  [configGroup]: [
    "cursor-api key set",
    "cursor-api key status",
    "cursor-api key delete",
    "cursor-api port show",
    "cursor-api port set <port>",
    "cursor-api configure list",
    "cursor-api configure agent opencode",
  ],
  [opsGroup]: [
    healthCommand,
    "cursor-api url",
    "cursor-api update check",
    "cursor-api update install",
  ],
  [serverGroup]: [
    startCommand,
    "cursor-api stop",
    "cursor-api restart",
    "cursor-api status",
    "cursor-api logs -f",
  ],
} as const;

const endpointRows = [
  ["GET", "/health", "Check the local server and report its URL and models."],
  ["GET", "/v1/models", "List composer-2.5 and composer-2.5-fast."],
  ["GET", "/v1/models/{id}", "Retrieve one listed model."],
  ["POST", "/v1/chat/completions", "OpenAI chat completions."],
  ["POST", "/v1/responses", "OpenAI Responses API shape."],
  [
    "GET / HEAD / DELETE",
    "/v1/responses/{id}",
    "Retrieve, inspect, or delete a response held in this process.",
  ],
  [
    "POST",
    "/v1/messages",
    "Anthropic Messages shape for Claude Code-style clients.",
  ],
  ["POST", "/v1/messages/count_tokens", "Anthropic token counting shape."],
] as const;

const clientRows = [
  ["Base URL", baseUrlValue],
  ["API key", apiKeyValue],
  ["Primary model", primaryModel],
  ["Fast model", fastModel],
  ["Bind address", "127.0.0.1"],
  ["Default port", "6903"],
] as const;

const agentSetupRows = [
  {
    description:
      "Use the bundled configurator to add the local OpenAI-compatible provider to OpenCode, so future sessions can select a Composer model.",
    name: "OpenCode",
    notes: [
      "The daemon does not need to be running to write the OpenCode config.",
      "Re-run it any time you change the daemon port.",
      "The configurator backs up an existing config before changing it.",
    ],
    settings: [
      ["Provider", "OpenAI-compatible local provider"],
      ["Base URL", baseUrlValue],
      ["API key", apiKeyValue],
      ["Models", `${primaryModel}, ${fastModel}`],
    ],
    steps: [
      ["Write OpenCode config", "cursor-api configure agent opencode"],
      ["Start the daemon", startCommand],
      ["Check the endpoint", healthCommand],
      [
        "Use the model",
        `Select ${fastModel} for quick edits or ${primaryModel} for deeper runs.`,
      ],
    ],
  },
  {
    description:
      "Configure Codex as a custom OpenAI-compatible provider when your Codex client exposes provider, base URL, API key, and model fields.",
    name: "Codex",
    notes: [
      "Use the OpenAI-compatible provider path, not Anthropic settings.",
      "The API key is a local placeholder used by clients that require a key field.",
      "If Codex shows connection errors, verify the daemon URL with cursor-api url.",
    ],
    settings: [
      ["Provider type", openAiCompatibleProvider],
      ["Base URL", baseUrlValue],
      ["API key", apiKeyValue],
      ["Default model", fastModel],
    ],
    steps: [
      [
        "Open provider settings",
        "Create or edit a custom OpenAI-compatible provider.",
      ],
      ["Set the base URL", baseUrlValue],
      ["Set the key", apiKeyValue],
      ["Set the model", fastModel],
      [
        "Validate",
        `Send a short prompt after cursor-api health returns ${healthyStatus}.`,
      ],
    ],
  },
  {
    description:
      "If your Pi setup supports a custom OpenAI-compatible provider, point it at the localhost endpoint and choose a Composer model.",
    name: "Pi",
    notes: [
      "Pi should target the local daemon, not the public OpenAI API.",
      "Use composer-2.5 when you want slower, more complete planning.",
      "Restart Pi after changing provider settings if it caches the connection.",
    ],
    settings: [
      ["Provider", "Custom OpenAI-compatible"],
      ["Base URL", baseUrlValue],
      ["API key", apiKeyValue],
      ["Model", fastModel],
    ],
    steps: [
      [
        "Open model settings",
        "Choose the custom provider or OpenAI-compatible option.",
      ],
      ["Paste endpoint", baseUrlValue],
      ["Paste key", apiKeyValue],
      ["Choose model", fastModel],
      ["Troubleshoot", "Run cursor-api logs -f while sending a Pi request."],
    ],
  },
  {
    description:
      "If your Kilo Code setup supports a custom OpenAI-compatible provider, use these values to route chat requests through the local daemon.",
    name: "Kilo Code",
    notes: [
      "Keep streaming enabled if Kilo Code offers a streaming toggle.",
      "Use chat completions or OpenAI-compatible mode.",
      "If model discovery is not automatic, enter both Composer model names manually.",
    ],
    settings: [
      ["Provider", openAiCompatibleProvider],
      ["Base URL", baseUrlValue],
      ["API key", apiKeyValue],
      ["Fast model", fastModel],
      ["Full model", primaryModel],
    ],
    steps: [
      [
        "Create provider",
        "Add a custom OpenAI-compatible provider in Kilo Code.",
      ],
      ["Configure endpoint", baseUrlValue],
      ["Configure key", apiKeyValue],
      ["Add models", `${fastModel} and ${primaryModel}`],
      ["Confirm", "Run cursor-api status before starting an agent task."],
    ],
  },
  {
    description:
      "Configure Aider's OpenAI-compatible connection with these values. The exact persistence method depends on how you run Aider.",
    name: "Aider",
    notes: [
      "Aider expects OpenAI-compatible names for the base URL and key.",
      "Use the fast model for patch loops and the full model for broad refactors.",
      "If you prefer one-off runs, pass the same values as environment variables or CLI flags.",
    ],
    settings: [
      ["OpenAI base URL", baseUrlValue],
      ["OpenAI API key", apiKeyValue],
      ["Default model", fastModel],
      ["Alternative model", primaryModel],
    ],
    steps: [
      ["Start daemon", startCommand],
      ["Set base URL", baseUrlValue],
      ["Set API key", apiKeyValue],
      ["Set default model", fastModel],
      ["Verify", "Ask Aider for a small repository summary."],
    ],
  },
  {
    description:
      "Use these values in any VS Code extension that lets you define a custom OpenAI-compatible endpoint.",
    name: "VS Code",
    notes: [
      "Different extensions name the same fields differently; match by meaning.",
      "The base URL must include /v1 for OpenAI-compatible extensions.",
      "Use cursor-api logs -f when an extension hides provider errors.",
    ],
    settings: [
      ["Provider type", openAiCompatibleProvider],
      ["Base URL", baseUrlValue],
      ["API key", apiKeyValue],
      ["Model", fastModel],
    ],
    steps: [
      ["Open extension settings", "Find provider, model, or API settings."],
      ["Choose custom provider", "Select OpenAI-compatible if available."],
      ["Save endpoint", baseUrlValue],
      ["Save key", apiKeyValue],
      [
        "Test request",
        "Use the extension while cursor-api logs -f is running.",
      ],
    ],
  },
] as const;

const lifecycleRows = [
  ["Install location", "%LOCALAPPDATA%\\Programs\\cursor-api\\"],
  ["Runtime layout", "cursor-api.exe plus a bundled bridge directory"],
  ["Server process", "Background daemon with PID state under AppData"],
  ["Bridge process", "Node runtime for local @cursor/sdk calls"],
  [
    "Fallback",
    "Direct path may run without the SDK bridge, with different capabilities",
  ],
  ["Updates", "Stop daemon, replace release files, preserve AppData config"],
] as const;

const troubleshootingRows = [
  [
    "401 or auth errors",
    "Run cursor-api key status, then cursor-api key set if needed.",
  ],
  [
    "Client cannot connect",
    "Run cursor-api status and confirm the client uses /v1 in the base URL.",
  ],
  ["Port conflict", "Use cursor-api port set <port>, then restart the daemon."],
  ["Need logs", "Run cursor-api logs -f while reproducing the client request."],
  [
    "Agent config drift",
    "Re-run cursor-api configure agent opencode after changing the port.",
  ],
] as const;

const storageRows = [
  ["Install", "%LOCALAPPDATA%\\Programs\\cursor-api\\"],
  ["Settings", "%APPDATA%\\cursor-api\\settings.json"],
  ["Encrypted key", "%APPDATA%\\cursor-api\\api-key.enc"],
  ["PID / state", "%APPDATA%\\cursor-api\\run\\"],
  ["Logs", "%APPDATA%\\cursor-api\\logs\\"],
] as const;

const creditRows = [
  [
    "standardagents/composer-api",
    "OpenAI-compatible translation, Cursor API adapters, the local bridge, and the sidecar server design.",
  ],
  [
    "API for Cursor Windows port",
    "Two-process architecture, bridge runtime constraints, agent config shapes, and local defaults.",
  ],
  [
    "@cursor/sdk",
    "Official Cursor SDK used by the bundled Node bridge to drive Composer agents.",
  ],
  [
    "Cursor Composer models",
    "Model names and capabilities are provided by Cursor. This project is independent.",
  ],
] as const;

const docsNav = [
  ["Overview", "#overview"],
  ["Client settings", "#client-settings"],
  ["Quick start", "#quick-start"],
  ["Agent setup", "#agent-setup"],
  ["Requests", "#requests"],
  ["API surface", "#api-surface"],
  ["Security and limits", "#security"],
  ["Runtime", "#runtime"],
  ["Troubleshooting", "#troubleshooting"],
  ["Commands", "#commands"],
  ["Storage", "#storage"],
  ["Credits", "#credits"],
] as const;

const rightRailLinks = [
  ["Install", "#quick-start"],
  ["Configure agents", "#agent-setup"],
  ["Send requests", "#requests"],
  ["Security and limits", "#security"],
  ["Debug", "#troubleshooting"],
] as const;

const CopyButton = ({ value }: { value: string }) => {
  const [copied, setCopied] = useState(false);
  const isMountedRef = useRef(true);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(value);
      if (!isMountedRef.current) {
        return;
      }
      setCopied(true);
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        resetTimerRef.current = null;
      }, 1600);
    } catch {
      if (!isMountedRef.current) {
        return;
      }
      setCopied(false);
    }
  };

  return (
    <button
      aria-label={copied ? "Copied to clipboard" : "Copy code"}
      className="border-border bg-background text-muted-foreground hover:text-foreground focus-visible:text-foreground absolute top-2 right-2 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium opacity-100 shadow-sm transition sm:opacity-0 sm:group-hover:opacity-100"
      onClick={copyValue}
      type="button"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
};

const CodeBlock = ({
  className = "",
  value,
}: {
  className?: string;
  value: string;
}) => (
  <div className="group relative">
    <CopyButton value={value} />
    <pre
      className={`border-border text-foreground bg-muted overflow-x-auto rounded-lg border p-4 pr-20 font-mono text-xs leading-6 ${className}`}
    >
      <code>{value}</code>
    </pre>
  </div>
);

const RequestExampleCard = ({
  children,
  title,
  value,
}: {
  children: React.ReactNode;
  title: string;
  value: string;
}) => (
  <div className="text-muted-foreground flex h-full flex-col text-sm leading-7">
    <h3 className="text-foreground mb-3 text-base font-semibold">{title}</h3>
    <div className="mb-5 min-h-20">{children}</div>
    <div className="mt-auto">
      <CodeBlock className="min-h-[21rem]" value={value} />
    </div>
  </div>
);

const Step = ({ label, command }: { label: string; command: string }) => (
  <div className="border-border bg-background rounded-lg border p-3 shadow-sm">
    <div className="text-foreground mb-2 text-sm font-medium">{label}</div>
    <CodeBlock value={command} />
  </div>
);

const AvailablePill = () => (
  <span className="border-border text-primary bg-muted inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium">
    <span className="status-pulse bg-primary size-1.5 rounded-full" />
    Available
  </span>
);

const AgentSetupPill = ({ name }: { name: string }) => (
  <span className="border-border text-muted-foreground bg-muted inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium">
    {name === "OpenCode" ? "CLI configurator" : "Manual setup guide"}
  </span>
);

const AgentSetupCard = ({
  description,
  name,
  notes,
  settings,
  steps,
}: (typeof agentSetupRows)[number]) => (
  <section className="border-border scroll-mt-24 border-b py-8 last:border-b-0">
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 className="text-foreground mb-2 text-xl font-semibold tracking-tight">
          {name}
        </h3>
        <p className="text-muted-foreground m-0 max-w-3xl text-sm leading-7">
          {description}
        </p>
      </div>
      <AgentSetupPill name={name} />
    </div>

    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0 space-y-7">
        <div>
          <h4 className="text-foreground mb-3 text-base font-semibold tracking-tight">
            Provider values
          </h4>
          <div className="border-border overflow-hidden rounded-lg border">
            {settings.map(([label, value]) => (
              <div
                className="border-border grid gap-1 border-b px-3 py-2.5 last:border-b-0 sm:grid-cols-[10rem_1fr]"
                key={label}
              >
                <span className="text-muted-foreground text-sm leading-6">
                  {label}
                </span>
                <code className="text-foreground border-0 bg-transparent p-0 font-mono text-xs leading-6 break-all">
                  {value}
                </code>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h4 className="text-foreground mb-3 text-base font-semibold tracking-tight">
            Suggested setup
          </h4>
          <ol className="m-0 space-y-4 p-0">
            {steps.map(([label, value], index) => (
              <li className="grid grid-cols-[1.75rem_1fr] gap-3" key={label}>
                <span className="border-border bg-background text-muted-foreground mt-0.5 flex size-7 items-center justify-center rounded-full border font-mono text-xs">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <div className="text-foreground mb-1 text-sm font-medium">
                    {label}
                  </div>
                  {value.startsWith("cursor-api") ||
                  value.startsWith("http") ? (
                    <CodeBlock value={value} />
                  ) : (
                    <p className="text-muted-foreground m-0 text-sm leading-7">
                      {value}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <aside className="lg:border-border lg:border-l lg:pl-5">
        <h4 className="text-foreground mb-3 text-base font-semibold tracking-tight">
          Notes
        </h4>
        <ul className="m-0 space-y-3 p-0">
          {notes.map((note) => (
            <li
              className="text-muted-foreground grid grid-cols-[0.75rem_1fr] gap-2 text-sm leading-7"
              key={note}
            >
              <span className="bg-primary mt-2 size-1.5 rounded-full" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  </section>
);

const DocsRail = () => (
  <aside className="hidden xl:block">
    <div className="sticky top-24 space-y-5">
      <div className="border-border bg-background rounded-xl border p-4 shadow-sm">
        <p className="text-foreground mb-3 text-sm font-medium">On this page</p>
        <nav className="space-y-1 text-sm">
          {rightRailLinks.map(([label, href]) => (
            <a
              className="text-muted-foreground hover:bg-muted hover:text-foreground block rounded-md px-2 py-1.5 no-underline"
              href={href}
              key={href}
            >
              {label}
            </a>
          ))}
        </nav>
      </div>

      <div className="text-muted-foreground border-border bg-muted rounded-xl border p-4 text-sm leading-6">
        <p className="text-foreground mb-2 font-medium">Local defaults</p>
        <div className="space-y-2">
          <div>
            <span className="text-muted-foreground block text-xs">
              Base URL
            </span>
            <code className="font-mono text-xs break-all">
              http://127.0.0.1:6903/v1
            </code>
          </div>
          <div>
            <span className="text-muted-foreground block text-xs">API key</span>
            <code className="font-mono text-xs">cursor-local</code>
          </div>
          <div>
            <span className="text-muted-foreground block text-xs">
              Fast model
            </span>
            <code className="font-mono text-xs">composer-2.5-fast</code>
          </div>
        </div>
      </div>
    </div>
  </aside>
);

const DocsSidebar = () => (
  <aside className="hidden lg:block">
    <nav className="sticky top-24 space-y-1 text-sm">
      <p className="text-muted-foreground mb-3 font-mono text-xs font-medium tracking-widest uppercase">
        Docs
      </p>
      {docsNav.map(([label, href]) => (
        <a
          className="text-muted-foreground hover:bg-muted hover:text-foreground block rounded-md px-2 py-1.5 no-underline"
          href={href}
          key={href}
        >
          {label}
        </a>
      ))}
    </nav>
  </aside>
);

const DocsIntroCard = () => (
  <div className="border-border bg-background rounded-xl border p-4 shadow-sm sm:p-5">
    <div className="mb-3 flex items-center justify-between gap-3">
      <h3 className="text-foreground m-0 text-base font-semibold tracking-tight">
        Quick reference
      </h3>
      <AvailablePill />
    </div>
    <div className="space-y-3">
      {clientRows.slice(0, 4).map(([label, value]) => (
        <div key={label}>
          <div className="text-muted-foreground mb-1 text-xs">{label}</div>
          <code className="font-mono text-xs leading-5 break-all">{value}</code>
        </div>
      ))}
    </div>
  </div>
);

const Detail = ({ label, value }: { label: string; value: string }) => (
  <div className="border-border grid gap-1 border-b py-3 last:border-b-0 sm:grid-cols-[12rem_1fr] sm:gap-4">
    <div className="text-foreground text-sm font-medium">{label}</div>
    <code className="text-muted-foreground font-mono text-xs leading-6 break-all">
      {value}
    </code>
  </div>
);

const SectionHeading = ({
  description,
  title,
}: {
  description: string;
  title: string;
}) => (
  <div className="mb-5">
    <h2 className="text-foreground mb-2 text-2xl font-semibold tracking-tight">
      {title}
    </h2>
    <p className="text-muted-foreground m-0 max-w-2xl text-sm leading-7">
      {description}
    </p>
  </div>
);

const SecuritySection = () => (
  <section className="border-border border-b py-8" id="security">
    <SectionHeading
      description="The API is intended for local clients. Treat the machine and processes running under your Windows account as trusted."
      title="Security and compatibility limits"
    />
    <div className="text-muted-foreground space-y-4 text-sm leading-7">
      <p>
        The server listens on <code>127.0.0.1</code>, not on your network
        interfaces. Requests authenticate with <code>x-api-key</code> or
        <code> Authorization: Bearer …</code>. Use <code>cursor-local</code> as
        the client-side placeholder; the daemon resolves it to the saved Cursor
        API key. A different supplied key is passed through as the credential.
        Do not share the saved Cursor key with untrusted local software.
      </p>
      <p>
        The saved key is encrypted using AES-256-GCM, with key material derived
        from the Windows username and computer name. This is not Windows
        Credential Manager or DPAPI protection. The encrypted file is stored at{" "}
        <code>%APPDATA%\cursor-api\api-key.enc</code>.
      </p>
      <ul className="list-disc space-y-2 pl-5">
        <li>
          This is a compatibility layer, not full OpenAI or Anthropic API
          parity. OpenAI requests with <code>n</code> other than 1, logprobs,
          non-text output modalities, or audio output are not supported; legacy
          function-calling fields and background Responses are also unsupported.
        </li>
        <li>
          Response lookup and deletion are best-effort, in-memory only, limited
          to 512 entries, and lost when the daemon restarts.
        </li>
        <li>
          Anthropic token counts are estimates (roughly one token per four
          characters), not provider-reported usage. Unsupported image sources
          may be converted to text; image URLs must use HTTP(S), and each image
          is limited to 1 MiB.
        </li>
        <li>
          Request bodies are limited to 25 MiB. SDK session/tool-call state is
          best-effort and expires after six hours; conversation history is not
          guaranteed to persist across restarts.
        </li>
      </ul>
    </div>
  </section>
);

const Docs = () => (
  <main className="mx-auto grid w-full max-w-[1440px] gap-8 px-4 py-10 lg:grid-cols-[13rem_minmax(0,1fr)] lg:px-6 lg:py-12 xl:grid-cols-[13rem_minmax(0,56rem)_17rem]">
    <DocsSidebar />

    <article className="min-w-0">
      <section className="border-border border-b pb-8" id="overview">
        <Badge variant="outline" className="mb-4">
          Documentation
        </Badge>
        <h1 className="mb-4 text-4xl font-semibold tracking-tight sm:text-5xl">
          cursor-api docs
        </h1>
        <p className="text-muted-foreground max-w-3xl text-lg leading-8">
          Run a local Windows daemon that exposes Cursor Composer through
          OpenAI-compatible and Anthropic-compatible API shapes for agent
          clients.
        </p>

        <div className="mt-6 grid gap-4 lg:grid-cols-[1fr_18rem]">
          <div className="border-border bg-background rounded-xl border p-4 shadow-sm sm:p-5">
            <p className="text-muted-foreground m-0 text-sm leading-7">
              The daemon binds to loopback, keeps your Cursor key encrypted
              under AppData, and translates common agent client requests through
              the bundled Cursor SDK bridge.
            </p>
          </div>
          <DocsIntroCard />
        </div>
      </section>

      <section className="border-border border-b py-8" id="client-settings">
        <SectionHeading
          description="Use these values in agent clients that support a custom local API endpoint."
          title="Client settings"
        />
        <div className="grid gap-2 sm:grid-cols-2">
          {clientRows.map(([label, value]) => (
            <Detail key={label} label={label} value={value} />
          ))}
        </div>
        <div className="text-muted-foreground border-border bg-muted mt-5 rounded-lg border p-4 text-sm leading-7">
          <p className="text-foreground mb-2 font-medium">
            Use these values in your client
          </p>
          <p className="m-0">
            Keep <code>/v1</code> at the end of the base URL. Enter{" "}
            <code>cursor-local</code> as the client API key when a key is
            required; it is a local placeholder, not your Cursor API key. Save
            the actual Cursor key separately with{" "}
            <code>cursor-api key set</code>. The daemon listens only on this
            computer at <code>127.0.0.1</code>.
          </p>
        </div>
      </section>

      <section className="border-border border-b py-8" id="quick-start">
        <SectionHeading
          description="Install the release bundle, store your Cursor key, then start the local daemon."
          title="Quick start"
        />
        <div className="space-y-3">
          {setupSteps.map(([label, command], index) => (
            <Step
              command={command}
              key={label}
              label={`${index + 1}. ${label}`}
            />
          ))}
        </div>
      </section>

      <section className="border-border border-b py-8" id="agent-setup">
        <SectionHeading
          description="Use these provider values as a starting point. Client settings and menu names vary by product and version."
          title="Agent setup"
        />
        <div className="text-muted-foreground border-border bg-muted mb-5 rounded-lg border p-4 text-sm leading-6">
          These values are for agent configuration, not for a one-off prompt.
          Use <code>cursor-local</code> as the API key and choose either
          Composer model in the client settings.
          <p className="mt-2 mb-0">
            The bundled <code>cursor-api configure agent</code> command
            currently writes OpenCode configuration only. The Codex, Pi, Kilo
            Code, Aider, and VS Code entries below are manual setup guides, not
            verified integrations. Those clients are not configured by the CLI
            command. <code>cursor-api configure list</code> reports CLI
            configurator status, not whether manual setup works.
          </p>
        </div>
        <div className="grid gap-5">
          {agentSetupRows.map((agent) => (
            <AgentSetupCard key={agent.name} {...agent} />
          ))}
        </div>
      </section>

      <section className="border-border border-b py-8" id="requests">
        <SectionHeading
          description="The server accepts common agent request shapes and translates them through the same Composer path."
          title="Request examples"
        />
        <div className="grid items-stretch gap-5 lg:grid-cols-2">
          <RequestExampleCard
            title="OpenAI-compatible"
            value={`POST http://127.0.0.1:6903/v1/chat/completions
Authorization: Bearer cursor-local
Content-Type: application/json

{
  "model": "composer-2.5-fast",
  "messages": [
    { "role": "user", "content": "Inspect this repo and suggest a fix." }
  ],
  "stream": true
}`}
          >
            <p>
              Use the same shape most OpenAI-compatible agents already emit. Set{" "}
              <code>stream</code> when your client expects server-sent events.
            </p>
          </RequestExampleCard>

          <RequestExampleCard
            title="Anthropic-compatible"
            value={`POST http://127.0.0.1:6903/v1/messages
x-api-key: cursor-local
anthropic-version: 2023-06-01
Content-Type: application/json

{
  "model": "composer-2.5",
  "max_tokens": 1200,
  "messages": [
    { "role": "user", "content": "Plan the next edit." }
  ]
}`}
          >
            <p>
              The local server also accepts the Anthropic Messages shape for
              Claude Code-style clients and translates it through the same
              Composer path.
            </p>
          </RequestExampleCard>
        </div>
      </section>

      <section className="border-border border-b py-8" id="api-surface">
        <SectionHeading
          description="The daemon binds to loopback and exposes a local health check plus the versioned /v1 API."
          title="API surface"
        />
        <div className="space-y-3">
          {endpointRows.map(([method, path, description]) => (
            <div
              className="border-border grid gap-2 border-b py-3 last:border-b-0 sm:grid-cols-[5rem_minmax(16rem,18rem)_1fr]"
              key={path}
            >
              <span className="text-primary font-mono text-xs font-semibold">
                {method}
              </span>
              <code className="w-fit max-w-full overflow-x-auto font-mono text-xs whitespace-nowrap">
                {path}
              </code>
              <span className="text-muted-foreground text-sm leading-6">
                {description}
              </span>
            </div>
          ))}
        </div>

        <div className="text-muted-foreground mt-8 max-w-2xl space-y-4 text-sm leading-7">
          <h3 className="text-foreground text-base font-semibold">
            Model choice
          </h3>
          <p>
            Use <code>composer-2.5</code> when an agent needs a more thorough
            planning or editing pass.
          </p>
          <Separator />
          <p>
            Use <code>composer-2.5-fast</code> when you want quicker turn-taking
            for iterative agent work.
          </p>
          <Separator />
          <p>
            Anthropic-compatible requests currently use{" "}
            <code>composer-2.5</code>
            regardless of the model name in the request.
          </p>
          <Separator />
          <p>
            These endpoints implement a subset of the upstream APIs. See the
            Security and compatibility limits section for unsupported options,
            payload limits, and state-retention behavior.
          </p>
        </div>
      </section>

      <SecuritySection />

      <section className="border-border border-b py-8" id="runtime">
        <SectionHeading
          description="The release bundle keeps the Bun-compiled CLI and Node bridge separate."
          title="Runtime lifecycle"
        />
        <div className="space-y-2">
          {lifecycleRows.map(([label, value]) => (
            <Detail key={label} label={label} value={value} />
          ))}
        </div>
      </section>

      <section className="border-border border-b py-8" id="troubleshooting">
        <SectionHeading
          description="Use these checks before changing client configuration or reinstalling."
          title="Troubleshooting"
        />
        <div className="space-y-2">
          {troubleshootingRows.map(([label, value]) => (
            <Detail key={label} label={label} value={value} />
          ))}
        </div>
      </section>

      <section className="border-border border-b py-8" id="commands">
        <SectionHeading
          description="The CLI command surface is grouped by daemon control, configuration, and operations."
          title="Command reference"
        />
        <Tabs defaultValue="Server">
          <TabsList className="mb-5 grid w-full grid-cols-3">
            {Object.keys(commandGroups).map((group) => (
              <TabsTrigger key={group} value={group}>
                {group}
              </TabsTrigger>
            ))}
          </TabsList>
          {Object.entries(commandGroups).map(([group, commands]) => (
            <TabsContent key={group} value={group}>
              <div className="grid gap-2">
                {commands.map((command) => (
                  <code
                    className="border-border bg-muted block rounded-lg border px-3 py-2 font-mono text-sm"
                    key={command}
                  >
                    {command}
                  </code>
                ))}
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </section>

      <section className="border-border border-b py-8" id="storage">
        <SectionHeading
          description="User configuration lives under AppData and is preserved across release updates."
          title="Where data lives"
        />
        <div className="space-y-2">
          {storageRows.map(([label, value]) => (
            <Detail key={label} label={label} value={value} />
          ))}
        </div>
      </section>

      <section className="py-8" id="credits">
        <SectionHeading
          description="cursor-api-windows is independent and builds on prior MIT work."
          title="Credits and scope"
        />
        <div className="grid gap-3 lg:grid-cols-2">
          {creditRows.map(([name, description]) => (
            <div
              className="border-border bg-background rounded-lg border p-4 shadow-sm"
              key={name}
            >
              <h3 className="mb-2 text-sm font-semibold">{name}</h3>
              <p className="text-muted-foreground m-0 text-sm leading-6">
                {description}
              </p>
            </div>
          ))}
        </div>
      </section>
    </article>

    <DocsRail />
  </main>
);

export const Route = createFileRoute("/docs")({
  component: Docs,
});
