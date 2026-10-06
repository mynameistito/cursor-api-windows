import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Bot,
  Braces,
  ChevronDown,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  KeyRound,
  Minus,
  PlugZap,
  Plus,
  Server,
  Shield,
  Square,
  Terminal,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

const releasesUrl =
  "https://github.com/mynameistito/cursor-api-windows/releases";
const localBaseUrl = "http://127.0.0.1:6903/v1";
const installCommand =
  "irm https://cursor-api-windows.mynameistito.com/install.ps1 | iex";

const agentClients = [
  {
    logo: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/opencode.svg",
    name: "OpenCode",
  },
  {
    logo: "https://raw.githubusercontent.com/openai/agents.md/main/public/logos/codex.svg",
    name: "Codex",
  },
  {
    logo: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/pi-coding-agent.svg",
    name: "Pi",
  },
  {
    logo: "https://raw.githubusercontent.com/openai/agents.md/main/public/logos/kilo-code.svg",
    name: "Kilo Code",
  },
  {
    logo: "https://raw.githubusercontent.com/openai/agents.md/main/public/logos/aider.svg",
    name: "Aider",
  },
  {
    logo: "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/vscode/vscode-original.svg",
    name: "VS Code",
  },
] as const;

const highlights = [
  {
    description:
      "Keep each agent pointed at the same localhost URL instead of hand-editing every client when ports or models change.",
    icon: PlugZap,
    title: "One endpoint",
  },
  {
    description:
      "Expose composer-2.5 and composer-2.5-fast through OpenAI-compatible and Anthropic-compatible request shapes.",
    icon: Bot,
    title: "Composer models",
  },
  {
    description:
      "Run the bridge in the background with daemon controls, health checks, logs, and update commands.",
    icon: Server,
    title: "Windows daemon",
  },
  {
    description:
      "Ship cursor-api.exe beside the bundled Node bridge needed for local Cursor SDK calls.",
    icon: Terminal,
    title: "Bundled bridge",
  },
] as const;

const models = [
  [
    "composer-2.5",
    "For deeper agent runs where quality matters more than response speed.",
  ],
  [
    "composer-2.5-fast",
    "For tight edit loops, quick planning passes, and interactive agent sessions.",
  ],
] as const;

const quickStart = [
  installCommand,
  "cursor-api key set",
  "cursor-api start",
  "cursor-api health",
  "cursor-api url",
] as const;

const runtimeTiles = [
  {
    icon: KeyRound,
    title: "API key",
    value: "cursor-local",
  },
  {
    icon: Server,
    title: "Base URL",
    value: localBaseUrl,
  },
  {
    icon: Braces,
    title: "Models",
    value: "composer-2.5 / composer-2.5-fast",
  },
  {
    icon: Shield,
    title: "Encrypted key",
    value: "%APPDATA%\\cursor-api\\api-key.enc",
  },
  {
    icon: Cpu,
    title: "Daemon state",
    value: "%APPDATA%\\cursor-api\\run\\",
  },
  {
    icon: Terminal,
    title: "Logs",
    value: "%APPDATA%\\cursor-api\\logs\\",
  },
] as const;

const CommandLine = ({ value }: { value: string }) => {
  const [copied, setCopied] = useState(false);

  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="group/line hover:bg-muted relative flex min-w-0 items-center gap-1.5 rounded-sm py-0.5 pr-9 text-xs leading-5 transition">
      <span className="text-muted-foreground shrink-0 select-none">
        PS C:\Users\user&gt;
      </span>
      <span className="text-foreground min-w-0 flex-1 [scrollbar-width:none] overflow-x-auto whitespace-nowrap [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {value}
      </span>
      <button
        aria-label={copied ? "Copied to clipboard" : "Copy command"}
        className="text-muted-foreground hover:text-foreground focus-visible:text-foreground border-border bg-background absolute right-0 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-sans text-xs font-medium opacity-100 transition focus-visible:opacity-100 sm:opacity-0 sm:group-hover/line:opacity-100"
        onClick={copyValue}
        type="button"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
};

const AgentLogo = ({ logo, name }: { logo: string; name: string }) => (
  <span
    className={`border-border flex size-11 items-center justify-center rounded-lg border shadow-sm ${
      name === "Pi" ? "bg-primary" : "bg-background/90"
    }`}
  >
    <img
      alt={`${name} logo`}
      className={`size-6 object-contain ${
        name === "Pi" || name === "VS Code" ? "" : "dark:invert"
      }`}
      loading="lazy"
      src={logo}
    />
  </span>
);

const AgentCard = ({ logo, name }: (typeof agentClients)[number]) => (
  <article className="group border-border bg-card hover:border-border rounded-lg border p-4 shadow-sm transition">
    <div className="mb-5 flex items-start justify-between gap-4">
      <AgentLogo logo={logo} name={name} />
      <span className="border-border bg-background text-muted-foreground inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium">
        <span className="status-pulse bg-primary size-1.5 rounded-full" />
        Available
      </span>
    </div>
    <h3 className="text-foreground m-0 text-base font-semibold">{name}</h3>
  </article>
);

const InfoTile = ({
  icon: Icon,
  title,
  value,
}: {
  icon: LucideIcon;
  title: string;
  value: string;
}) => (
  <Card>
    <CardContent>
      <div className="space-y-4 p-5">
        <Icon className="text-primary size-5" />
        <div>
          <h3 className="mb-2 text-sm font-semibold">{title}</h3>
          <p className="text-muted-foreground m-0 font-mono text-xs leading-5 break-words">
            {value}
          </p>
        </div>
        <CheckCircle2 className="text-primary size-4" />
      </div>
    </CardContent>
  </Card>
);

const HeroConsole = () => (
  <div className="rise-in relative">
    <div className="border-border bg-background text-foreground relative overflow-hidden rounded-lg border shadow-sm">
      <div className="border-border bg-muted border-b">
        <div className="text-muted-foreground flex h-9 items-stretch justify-between text-sm">
          <div className="flex min-w-0 items-stretch">
            <div className="bg-background text-foreground flex min-w-0 items-center gap-2 rounded-br-md px-2.5">
              <span className="text-primary border-primary bg-muted flex size-4 items-center justify-center rounded-sm border text-xs">
                &gt;_
              </span>
              <span className="truncate font-sans text-xs font-semibold">
                PowerShell
              </span>
              <X className="text-muted-foreground ml-8 size-3.5" />
            </div>
            <span
              aria-hidden="true"
              className="border-border text-muted-foreground hover:bg-muted flex w-11 items-center justify-center border-x"
            >
              <Plus className="size-4" />
            </span>
            <span
              aria-hidden="true"
              className="text-muted-foreground hover:bg-muted flex w-9 items-center justify-center"
            >
              <ChevronDown className="size-4" />
            </span>
          </div>
          <div className="hidden items-center sm:flex">
            <span className="text-muted-foreground flex h-9 w-11 items-center justify-center">
              <Minus className="size-4" />
            </span>
            <span className="text-muted-foreground flex h-9 w-11 items-center justify-center">
              <Square className="size-3" />
            </span>
            <span className="text-muted-foreground flex h-9 w-11 items-center justify-center">
              <X className="size-4" />
            </span>
          </div>
        </div>
      </div>
      <div className="space-y-3 p-4 font-mono text-sm leading-6">
        <div className="text-muted-foreground space-y-0">
          <div>PowerShell 7.6.3</div>
          <div>PS C:\Users\user&gt;</div>
        </div>
        <div className="space-y-0 overflow-hidden">
          {quickStart.map((command) => (
            <CommandLine key={command} value={command} />
          ))}
        </div>
        <Separator />
        <div className="grid gap-3 sm:grid-cols-2">
          {models.map(([name, description]) => (
            <div
              className="border-border bg-muted rounded-lg border p-4"
              key={name}
            >
              <div className="text-foreground mb-2 flex items-center gap-2">
                <Bot className="text-primary size-4" />
                <span>{name}</span>
              </div>
              <p className="text-muted-foreground m-0 font-sans text-sm leading-6">
                {description}
              </p>
            </div>
          ))}
        </div>
        <div className="border-border bg-muted text-muted-foreground rounded-lg border p-4">
          Base URL: <span className="text-foreground">{localBaseUrl}</span> ·
          API key: <span className="text-foreground">cursor-local</span>
        </div>
      </div>
    </div>
  </div>
);

const App = () => (
  <main className="mx-auto w-full max-w-[1280px] px-4 pt-8 pb-10 sm:pt-12">
    <section className="grid min-h-[calc(100dvh-6rem)] items-center gap-10 lg:grid-cols-[0.95fr_1.05fr]">
      <div className="rise-in max-w-3xl">
        <Badge className="mb-5" variant="outline">
          Cursor Composer 2.5 API for Local AI Harnesses
        </Badge>
        <h1 className="text-foreground mb-5 max-w-4xl text-5xl leading-none font-semibold tracking-tight sm:text-6xl lg:text-7xl">
          Put Composer behind every coding agent.
        </h1>
        <p className="text-muted-foreground mb-7 max-w-xl text-lg leading-8 text-pretty">
          An unofficial CLI that exposes Cursor Composer 2.5 through one local
          OpenAI-compatible API.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button asChild className="active:translate-y-px" size="lg">
            <a href={releasesUrl} rel="noreferrer" target="_blank">
              View Releases
              <ArrowRight className="size-4" />
            </a>
          </Button>
          <Button
            asChild
            className="active:translate-y-px"
            size="lg"
            variant="outline"
          >
            <Link to="/docs">Read Docs</Link>
          </Button>
        </div>
      </div>

      <HeroConsole />
    </section>

    <section className="py-14">
      <div className="mb-7 max-w-2xl">
        <h2 className="text-foreground m-0 text-3xl font-semibold tracking-tight sm:text-4xl">
          Allowed where agents can point at a local API.
        </h2>
        <p className="text-muted-foreground mt-3 text-base leading-7">
          Each supported client can point at the same local OpenAI-compatible
          endpoint.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        {agentClients.map((agent) => (
          <AgentCard key={agent.name} {...agent} />
        ))}
      </div>
    </section>

    <section className="grid gap-4 py-12 lg:grid-cols-[1.15fr_0.85fr]">
      <div className="grid auto-rows-fr gap-4 sm:grid-cols-2">
        {highlights.map(({ description, icon: Icon, title }) => (
          <Card className="group h-full" key={title}>
            <CardHeader>
              <div className="border-border bg-muted text-primary mb-4 flex size-10 items-center justify-center rounded-lg border">
                <Icon className="size-4" />
              </div>
              <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardContent>{description}</CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent>
          <div className="flex h-full flex-col justify-between gap-10 p-6">
            <div className="space-y-4">
              <PlugZap className="text-primary size-6" />
              <h2 className="m-0 text-3xl font-semibold tracking-tight sm:text-4xl">
                Drop it into the tools you already use.
              </h2>
              <p className="text-muted-foreground m-0 text-base leading-7">
                Configure your agent client with a local base URL, the literal
                key, and either Composer model name.
              </p>
            </div>
            <Button asChild variant="outline">
              <Link to="/docs">Open setup guide</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </section>

    <section className="py-10">
      <div className="mb-6 max-w-2xl">
        <h2 className="m-0 text-3xl font-semibold tracking-tight sm:text-4xl">
          Windows-native control plane.
        </h2>
        <p className="text-muted-foreground mt-3 text-base leading-7">
          Settings live in AppData, the API key is encrypted, and updates
          preserve local configuration.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {runtimeTiles.map((tile) => (
          <InfoTile key={tile.title} {...tile} />
        ))}
      </div>
    </section>
  </main>
);

export const Route = createFileRoute("/")({ component: App });
