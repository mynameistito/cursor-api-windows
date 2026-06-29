import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const installCommand =
  "irm https://cursor-api-windows.mynameistito.com/install.ps1 | iex";

const setupSteps = [
  ["Install", installCommand],
  ["Save your Cursor key", "cursor-api key set"],
  ["Start the daemon", "cursor-api start"],
  ["Verify the server", "cursor-api health"],
  ["Copy the base URL", "cursor-api url"],
] as const;

const commandGroups = {
  Config: [
    "cursor-api key set",
    "cursor-api key status",
    "cursor-api port show",
    "cursor-api port set <port>",
    "cursor-api configure agent opencode",
  ],
  Ops: [
    "cursor-api health",
    "cursor-api url",
    "cursor-api update check",
    "cursor-api update install",
  ],
  Server: [
    "cursor-api start",
    "cursor-api stop",
    "cursor-api restart",
    "cursor-api status",
    "cursor-api logs -f",
  ],
} as const;

const endpointRows = [
  ["GET", "/v1/models", "List composer-2.5 and composer-2.5-fast."],
  ["POST", "/v1/chat/completions", "OpenAI chat completions."],
  ["POST", "/v1/responses", "OpenAI Responses API shape."],
  [
    "POST",
    "/v1/messages",
    "Anthropic Messages shape for Claude Code-style clients.",
  ],
  ["POST", "/v1/messages/count_tokens", "Anthropic token counting shape."],
] as const;

const clientRows = [
  ["Base URL", "http://127.0.0.1:6903/v1"],
  ["API key", "cursor-local"],
  ["Primary model", "composer-2.5"],
  ["Fast model", "composer-2.5-fast"],
  ["Bind address", "127.0.0.1"],
  ["Default port", "6903"],
] as const;

const lifecycleRows = [
  ["Install location", "%LOCALAPPDATA%\\Programs\\cursor-api\\"],
  ["Runtime layout", "cursor-api.exe plus a bundled bridge directory"],
  ["Server process", "Background daemon with PID state under AppData"],
  ["Bridge process", "Node runtime for local @cursor/sdk calls"],
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
  ["Quick start", "#quick-start"],
  ["Agent clients", "#agent-clients"],
  ["Requests", "#requests"],
  ["API surface", "#api-surface"],
  ["Runtime", "#runtime"],
  ["Commands", "#commands"],
  ["Storage", "#storage"],
  ["Credits", "#credits"],
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
      className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-border bg-background/90 px-2 py-1 font-medium text-[0.68rem] text-muted-foreground opacity-100 shadow-sm transition hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100"
      onClick={copyValue}
      type="button"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
};

const CodeBlock = ({ value }: { value: string }) => (
  <div className="group relative">
    <CopyButton value={value} />
    <pre className="overflow-x-auto rounded-lg border border-border bg-muted/55 p-4 pr-20 font-mono text-xs leading-6 text-foreground">
      <code>{value}</code>
    </pre>
  </div>
);

const Step = ({ label, command }: { label: string; command: string }) => (
  <div className="rounded-lg border border-border bg-muted/35 p-3">
    <div className="mb-2 text-sm font-medium text-foreground">{label}</div>
    <CodeBlock value={command} />
  </div>
);

const Detail = ({ label, value }: { label: string; value: string }) => (
  <div className="grid gap-1 border-b border-border py-3 last:border-b-0 sm:grid-cols-[12rem_1fr] sm:gap-4">
    <div className="text-sm font-medium text-foreground">{label}</div>
    <code className="break-all font-mono text-xs leading-6 text-muted-foreground">
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
    <h2 className="mb-2 text-2xl font-semibold tracking-[-0.03em] text-foreground">
      {title}
    </h2>
    <p className="m-0 max-w-2xl text-sm leading-7 text-muted-foreground">
      {description}
    </p>
  </div>
);

const Docs = () => (
  <main className="mx-auto grid w-full max-w-[1240px] gap-10 px-4 py-10 lg:grid-cols-[14rem_1fr] lg:py-12">
    <aside className="hidden lg:block">
      <nav className="sticky top-24 space-y-1 text-sm">
        <p className="mb-3 font-mono text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Docs
        </p>
        {docsNav.map(([label, href]) => (
          <a
            className="block rounded-md px-2 py-1.5 text-muted-foreground no-underline hover:bg-muted hover:text-foreground"
            href={href}
            key={href}
          >
            {label}
          </a>
        ))}
      </nav>
    </aside>

    <article className="min-w-0 max-w-4xl">
      <section className="border-b border-border pb-8" id="overview">
        <Badge
          variant="outline"
          className="mb-4 rounded-md bg-background/80 px-2.5 py-1 font-mono text-xs"
        >
          Documentation
        </Badge>
        <h1 className="mb-4 text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">
          cursor-api docs
        </h1>
        <p className="max-w-3xl text-lg leading-8 text-muted-foreground">
          Run a local Windows daemon that exposes Cursor Composer through
          OpenAI-compatible and Anthropic-compatible API shapes for agent
          clients.
        </p>
      </section>

      <section className="border-b border-border py-8">
        <SectionHeading
          description="Use these values in agent clients that support a custom local API endpoint."
          title="Client settings"
        />
        <div className="grid gap-2 sm:grid-cols-2">
          {clientRows.map(([label, value]) => (
            <Detail key={label} label={label} value={value} />
          ))}
        </div>
      </section>

      <section className="border-b border-border py-8" id="quick-start">
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

      <section className="border-b border-border py-8" id="agent-clients">
        <SectionHeading
          description="Any client that can set an OpenAI-compatible base URL can point at the daemon."
          title="Agent clients"
        />
        <div className="space-y-4 text-sm leading-7 text-muted-foreground">
          <p>
            Use <code>cursor-local</code> as the local API key and choose either
            Composer model name.
          </p>
          <CodeBlock
            value={`OPENAI_BASE_URL=http://127.0.0.1:6903/v1
OPENAI_API_KEY=cursor-local
OPENAI_MODEL=composer-2.5-fast`}
          />
          <p>
            The CLI also includes an agent configuration command for supported
            clients, starting with OpenCode.
          </p>
          <CodeBlock value="cursor-api configure agent opencode" />
        </div>
      </section>

      <section className="border-b border-border py-8" id="requests">
        <SectionHeading
          description="The server accepts common agent request shapes and translates them through the same Composer path."
          title="Request examples"
        />
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-4 text-sm leading-7 text-muted-foreground">
            <h3 className="text-base font-semibold text-foreground">
              OpenAI-compatible
            </h3>
            <p>
              Use the same shape most OpenAI-compatible agents already emit. Set{" "}
              <code>stream</code> when your client expects server-sent events.
            </p>
            <CodeBlock
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
            />
          </div>

          <div className="space-y-4 text-sm leading-7 text-muted-foreground">
            <h3 className="text-base font-semibold text-foreground">
              Anthropic-compatible
            </h3>
            <p>
              The local server also accepts the Anthropic Messages shape for
              Claude Code-style clients and translates it through the same
              Composer path.
            </p>
            <CodeBlock
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
            />
          </div>
        </div>
      </section>

      <section className="border-b border-border py-8" id="api-surface">
        <SectionHeading
          description="The daemon binds to loopback and exposes only the local /v1 surface."
          title="API surface"
        />
        <div className="space-y-3">
          {endpointRows.map(([method, path, description]) => (
            <div
              className="grid gap-2 border-b border-border py-3 last:border-b-0 sm:grid-cols-[5rem_13rem_1fr]"
              key={path}
            >
              <span className="font-mono text-xs font-semibold text-[var(--lagoon)]">
                {method}
              </span>
              <code className="break-all font-mono text-xs">{path}</code>
              <span className="text-sm leading-6 text-muted-foreground">
                {description}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-8 max-w-2xl space-y-4 text-sm leading-7 text-muted-foreground">
          <h3 className="text-base font-semibold text-foreground">
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
        </div>
      </section>

      <section className="border-b border-border py-8" id="runtime">
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

      <section className="border-b border-border py-8">
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

      <section className="border-b border-border py-8" id="commands">
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
                    className="block rounded-lg border border-border bg-muted px-3 py-2 font-mono text-sm"
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

      <section className="border-b border-border py-8" id="storage">
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
              className="rounded-xl border border-border bg-muted/45 p-4"
              key={name}
            >
              <h3 className="mb-2 text-sm font-semibold">{name}</h3>
              <p className="m-0 text-sm leading-6 text-muted-foreground">
                {description}
              </p>
            </div>
          ))}
        </div>
      </section>
    </article>
  </main>
);

export const Route = createFileRoute("/docs")({
  component: Docs,
});
