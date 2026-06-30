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

const repoUrl = "https://github.com/mynameistito/cursor-api-windows";
const installCommand =
  "irm https://cursor-api-windows.mynameistito.com/install.ps1 | iex";

const agentClients = [
  {
    logo: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/opencode.svg",
    name: "OpenCode",
    setup: "cursor-api configure agent opencode",
    status: "Autoconfigured",
  },
  {
    logo: "https://raw.githubusercontent.com/openai/agents.md/main/public/logos/codex.svg",
    name: "Codex",
    setup: "OPENAI_BASE_URL=http://127.0.0.1:6903/v1",
    status: "OpenAI shape",
  },
  {
    logo: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/pi-coding-agent.svg",
    name: "Pi",
    setup: "OPENAI_API_KEY=cursor-local",
    status: "Local API",
  },
  {
    logo: "https://raw.githubusercontent.com/openai/agents.md/main/public/logos/kilo-code.svg",
    name: "Kilo Code",
    setup: "OPENAI_MODEL=composer-2.5-fast",
    status: "Composer fast",
  },
  {
    logo: "https://raw.githubusercontent.com/openai/agents.md/main/public/logos/aider.svg",
    name: "Aider",
    setup: "--openai-api-base http://127.0.0.1:6903/v1",
    status: "CLI-ready",
  },
  {
    logo: "https://cdn.simpleicons.org/visualstudiocode/000000",
    name: "VS Code",
    setup: "Use the same /v1 base URL in compatible extensions",
    status: "Extensions",
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
    value: "http://127.0.0.1:6903/v1",
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
    <div className="group/line relative flex min-w-0 items-center gap-1.5 rounded-sm py-0.5 pr-9 text-[0.68rem] leading-5 transition hover:bg-white/[0.04]">
      <span className="shrink-0 select-none text-zinc-400">
        PS C:\Users\mynameistito&gt;
      </span>
      <span className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-zinc-100 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {value}
      </span>
      <button
        className="absolute right-0 inline-flex items-center gap-1 rounded-md border border-white/10 bg-[#080808] px-2 py-0.5 font-sans text-[0.68rem] font-medium text-zinc-500 opacity-100 transition hover:text-zinc-100 sm:opacity-0 sm:group-hover/line:opacity-100"
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
    className={`flex size-11 items-center justify-center rounded-2xl border border-border shadow-[0_1px_0_rgba(255,255,255,0.08)_inset] ${
      name === "Pi" ? "bg-zinc-950" : "bg-background/90"
    }`}
  >
    <img
      alt={`${name} logo`}
      className={`size-6 object-contain ${name === "Pi" ? "" : "dark:invert"}`}
      loading="lazy"
      src={logo}
    />
  </span>
);

const AgentCard = ({
  logo,
  name,
  setup,
  status,
}: (typeof agentClients)[number]) => (
  <article className="group rounded-[1.25rem] border border-border bg-card/78 p-4 shadow-none backdrop-blur transition hover:-translate-y-1 hover:border-[color-mix(in_oklab,var(--lagoon)_42%,var(--border))]">
    <div className="mb-5 flex items-start justify-between gap-4">
      <AgentLogo logo={logo} name={name} />
      <span className="rounded-full border border-border bg-muted/60 px-2.5 py-1 font-mono text-[0.66rem] text-muted-foreground">
        {status}
      </span>
    </div>
    <h3 className="m-0 text-base font-semibold tracking-[-0.02em] text-foreground">
      {name}
    </h3>
    <p className="mt-3 min-h-10 break-words font-mono text-xs leading-5 text-muted-foreground">
      {setup}
    </p>
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
  <Card className="rounded-[1.15rem] border-border bg-card/80 shadow-none transition-transform hover:-translate-y-1">
    <CardContent className="space-y-4 p-5">
      <Icon className="size-5 text-[var(--lagoon)]" />
      <div>
        <h3 className="mb-2 text-sm font-semibold">{title}</h3>
        <p className="m-0 break-words font-mono text-xs leading-5 text-muted-foreground">
          {value}
        </p>
      </div>
      <CheckCircle2 className="size-4 text-[var(--palm)]" />
    </CardContent>
  </Card>
);

const HeroConsole = () => (
  <div className="relative rise-in [animation-delay:120ms]">
    <div className="absolute -left-8 top-12 hidden h-32 w-32 rounded-full bg-[color-mix(in_oklab,var(--lagoon)_24%,transparent)] blur-3xl lg:block" />
    <Card className="relative overflow-hidden rounded-[1.35rem] border-border bg-[#080808] py-0 text-zinc-100 shadow-[0_28px_90px_rgba(0,0,0,0.22)] backdrop-blur dark:bg-[#080808]">
      <div className="border-b border-white/5 bg-[#2b2b2b]">
        <div className="flex h-9 items-stretch justify-between text-sm text-zinc-300">
          <div className="flex min-w-0 items-stretch">
            <div className="flex min-w-0 items-center gap-2 rounded-br-md bg-[#080808] px-2.5 text-zinc-100">
              <span className="flex size-4 items-center justify-center rounded-[3px] border border-[#5f8fce]/60 bg-[#111827] text-[0.6rem] text-[#8bc7ff]">
                &gt;_
              </span>
              <span className="truncate font-sans text-xs font-semibold">
                PowerShell
              </span>
              <X className="ml-8 size-3.5 text-zinc-300" />
            </div>
            <button
              aria-label="New tab"
              className="flex w-11 items-center justify-center border-x border-white/5 text-zinc-300 hover:bg-white/[0.05]"
              type="button"
            >
              <Plus className="size-4" />
            </button>
            <button
              aria-label="Tab menu"
              className="flex w-9 items-center justify-center text-zinc-300 hover:bg-white/[0.05]"
              type="button"
            >
              <ChevronDown className="size-4" />
            </button>
          </div>
          <div className="hidden items-center sm:flex">
            <span className="flex h-9 w-11 items-center justify-center text-zinc-300">
              <Minus className="size-4" />
            </span>
            <span className="flex h-9 w-11 items-center justify-center text-zinc-300">
              <Square className="size-3" />
            </span>
            <span className="flex h-9 w-11 items-center justify-center text-zinc-300">
              <X className="size-4" />
            </span>
          </div>
        </div>
      </div>
      <CardContent className="space-y-3 p-4 font-mono text-sm leading-6">
        <div className="space-y-0 text-zinc-300">
          <div>PowerShell 7.6.3</div>
          <div>PS C:\Users\mynameistito&gt;</div>
        </div>
        <div className="space-y-0 overflow-hidden">
          {quickStart.map((command) => (
            <CommandLine key={command} value={command} />
          ))}
        </div>
        <Separator className="bg-white/10" />
        <div className="grid gap-3 sm:grid-cols-2">
          {models.map(([name, description]) => (
            <div
              className="rounded-xl border border-white/10 bg-white/[0.04] p-4"
              key={name}
            >
              <div className="mb-2 flex items-center gap-2 text-zinc-100">
                <Bot className="size-4 text-[var(--lagoon)]" />
                <span>{name}</span>
              </div>
              <p className="m-0 font-sans text-sm leading-6 text-zinc-400">
                {description}
              </p>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-[color-mix(in_oklab,var(--lagoon)_35%,transparent)] bg-[color-mix(in_oklab,var(--lagoon)_12%,transparent)] p-4 text-zinc-400">
          Base URL: <span className="text-zinc-100">/v1</span> · API key:{" "}
          <span className="text-zinc-100">cursor-local</span>
        </div>
      </CardContent>
    </Card>
  </div>
);

const App = () => (
  <main className="mx-auto w-full max-w-[1280px] px-4 pb-10 pt-8 sm:pt-12">
    <section className="grid min-h-[calc(100dvh-6rem)] items-center gap-10 lg:grid-cols-[0.95fr_1.05fr]">
      <div className="max-w-3xl rise-in">
        <Badge
          className="mb-5 rounded-full border-[color-mix(in_oklab,var(--lagoon)_32%,var(--border))] bg-background/80 px-3 py-1 font-mono text-xs"
          variant="outline"
        >
          Cursor Composer for local agents
        </Badge>
        <h1 className="mb-5 max-w-4xl text-5xl font-semibold leading-[0.96] tracking-[-0.065em] text-foreground sm:text-6xl lg:text-7xl">
          Put Composer behind every coding agent.
        </h1>
        <p className="mb-7 max-w-xl text-pretty text-lg leading-8 text-muted-foreground">
          An unofficial CLI that exposes Cursor Composer 2.5 through one local
          OpenAI-compatible API.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            asChild
            className="rounded-full px-6 shadow-[0_16px_40px_rgba(0,107,255,0.18)] active:translate-y-px"
            size="lg"
          >
            <a href={repoUrl} rel="noreferrer" target="_blank">
              View Releases
              <ArrowRight className="size-4" />
            </a>
          </Button>
          <Button
            asChild
            className="rounded-full bg-background/70 px-6 active:translate-y-px"
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
        <h2 className="m-0 text-3xl font-semibold tracking-[-0.045em] text-foreground sm:text-4xl">
          Allowed where agents can point at a local API.
        </h2>
        <p className="mt-3 text-base leading-7 text-muted-foreground">
          OpenAI-compatible clients use the same localhost endpoint, key, and
          Composer model names.
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
          <Card
            className="group h-full rounded-[1.25rem] border-border bg-card/82 shadow-none transition-transform hover:-translate-y-1"
            key={title}
          >
            <CardHeader>
              <div className="mb-4 flex size-10 items-center justify-center rounded-2xl border border-border bg-muted text-[var(--lagoon)]">
                <Icon className="size-4" />
              </div>
              <CardTitle className="text-base tracking-[-0.02em]">
                {title}
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm leading-6 text-muted-foreground">
              {description}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="rounded-[1.35rem] border-[color-mix(in_oklab,var(--lagoon)_26%,var(--border))] bg-[color-mix(in_oklab,var(--lagoon)_8%,var(--card))] shadow-none">
        <CardContent className="flex h-full flex-col justify-between gap-10 p-6">
          <div className="space-y-4">
            <PlugZap className="size-6 text-[var(--lagoon)]" />
            <h2 className="m-0 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              Drop it into the tools you already use.
            </h2>
            <p className="m-0 text-base leading-7 text-muted-foreground">
              Configure your agent client with a local base URL, the literal
              key, and either Composer model name.
            </p>
          </div>
          <Button asChild className="w-fit rounded-full" variant="outline">
            <Link to="/docs">Open setup guide</Link>
          </Button>
        </CardContent>
      </Card>
    </section>

    <section className="py-10">
      <div className="mb-6 max-w-2xl">
        <h2 className="m-0 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
          Windows-native control plane.
        </h2>
        <p className="mt-3 text-base leading-7 text-muted-foreground">
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
