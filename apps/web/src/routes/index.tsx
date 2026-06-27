import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Bot,
  Braces,
  Check,
  CheckCircle2,
  Copy,
  Cpu,
  KeyRound,
  PlugZap,
  Server,
  Shield,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export const Route = createFileRoute("/")({ component: App });

const repoUrl = "https://github.com/mynameistito/cursor-api-cli-windows";
const installCommand =
  "irm https://cursor-api-windows.mynameistito.com/install.ps1 | iex";

const highlights = [
  [
    "Agent-ready endpoint",
    "Point OpenAI-compatible tools at localhost and keep your agent workflow intact.",
  ],
  [
    "Composer model names",
    "Expose composer-2.5 and composer-2.5-fast through one local API surface.",
  ],
  [
    "Windows daemon",
    "Run the server in the background with status, logs, health, and update commands.",
  ],
  [
    "Bundled bridge",
    "Ship cursor-api.exe beside the Node bridge needed for local Cursor SDK calls.",
  ],
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

const agentClients = [
  "OpenCode",
  "Codex",
  "VS Code",
  "custom scripts",
] as const;

const quickStart = [
  "cursor-api key set",
  "cursor-api start",
  "cursor-api status",
  "cursor-api health",
  "cursor-api url",
] as const;

function App() {
  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 pb-10 pt-8 sm:pt-12">
      <section className="grid min-h-[calc(100dvh-7rem)] items-center gap-8 lg:grid-cols-[0.92fr_1.08fr]">
        <div className="max-w-3xl rise-in">
          <Badge
            variant="outline"
            className="mb-5 rounded-full border-[color-mix(in_oklab,var(--lagoon)_30%,var(--border))] bg-background/80 px-3 py-1 font-mono text-xs"
          >
            Cursor Composer for local agents
          </Badge>
          <h1 className="mb-5 max-w-4xl text-5xl font-semibold leading-[0.95] tracking-[-0.065em] text-foreground sm:text-6xl lg:text-7xl">
            Use Composer 2.5 from any agent.
          </h1>
          <p className="mb-7 max-w-2xl text-pretty text-lg leading-8 text-muted-foreground">
            A Windows CLI that exposes Cursor Composer as a local
            OpenAI-compatible API for agent tools.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              asChild
              size="lg"
              className="rounded-full px-6 shadow-[0_16px_40px_rgba(0,107,255,0.18)] active:translate-y-px"
            >
              <a href={repoUrl} target="_blank" rel="noreferrer">
                View Releases
                <ArrowRight className="size-4" />
              </a>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="rounded-full bg-background/70 px-6 active:translate-y-px"
            >
              <Link to="/docs">Read Docs</Link>
            </Button>
          </div>
          <div className="mt-8 flex flex-wrap gap-2">
            {agentClients.map((client) => (
              <span
                key={client}
                className="rounded-full border border-border bg-card/70 px-3 py-1 font-mono text-xs text-muted-foreground"
              >
                {client}
              </span>
            ))}
          </div>
        </div>

        <div className="relative rise-in [animation-delay:120ms]">
          <div className="absolute -left-4 top-8 hidden h-28 w-28 rounded-full bg-[color-mix(in_oklab,var(--lagoon)_28%,transparent)] blur-3xl lg:block" />
          <Card className="relative overflow-hidden rounded-[1.4rem] border-border bg-card/92 py-0 shadow-[0_28px_90px_rgba(0,0,0,0.14)] backdrop-blur">
            <CardHeader className="border-b border-border bg-muted/40 px-4 py-3">
              <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-[#ff676d]" />
                  <span className="size-2 rounded-full bg-[#ffa600]" />
                  <span className="size-2 rounded-full bg-[#28a948]" />
                  <span className="ml-2 font-mono text-xs">PowerShell</span>
                </div>
                <span className="rounded-full border border-border bg-background px-2 py-1 font-mono text-[0.65rem]">
                  127.0.0.1:6903
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-5 p-5 font-mono text-sm leading-7">
              <CommandLine value={installCommand} />
              {quickStart.map((command) => (
                <CommandLine key={command} value={command} />
              ))}
              <Separator />
              <div className="grid gap-3 sm:grid-cols-2">
                {models.map(([name, description]) => (
                  <div
                    key={name}
                    className="rounded-xl border border-border bg-muted/45 p-4"
                  >
                    <div className="mb-2 flex items-center gap-2 text-foreground">
                      <Bot className="size-4 text-[var(--lagoon)]" />
                      <span>{name}</span>
                    </div>
                    <p className="m-0 font-sans text-sm leading-6 text-muted-foreground">
                      {description}
                    </p>
                  </div>
                ))}
              </div>
              <div className="rounded-xl border border-[color-mix(in_oklab,var(--lagoon)_35%,var(--border))] bg-[color-mix(in_oklab,var(--lagoon)_10%,transparent)] p-4 text-muted-foreground">
                Base URL: <span className="text-foreground">/v1</span> · API
                key: <span className="text-foreground">cursor-local</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="grid gap-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
        {highlights.map(([title, description], index) => (
          <Card
            key={title}
            className="group rounded-[1.15rem] border-border bg-card/86 shadow-none transition-transform hover:-translate-y-1 lg:[&:nth-child(2)]:mt-8 lg:[&:nth-child(3)]:-mt-4"
          >
            <CardHeader>
              <div className="mb-4 flex size-9 items-center justify-center rounded-full border border-border bg-muted text-[var(--lagoon)]">
                <FeatureIcon index={index} />
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
      </section>

      <section className="grid gap-4 py-10 lg:grid-cols-[0.78fr_1.22fr]">
        <Card className="rounded-[1.35rem] border-border bg-card/90 shadow-none">
          <CardContent className="space-y-4 p-6">
            <PlugZap className="size-6 text-[var(--lagoon)]" />
            <h2 className="m-0 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
              Drop it into the tools you already use.
            </h2>
            <p className="m-0 text-base leading-7 text-muted-foreground">
              Configure your agent client with a local base URL, the literal
              key, and either Composer model name.
            </p>
            <Button asChild variant="outline" className="rounded-full">
              <Link to="/docs">Open setup guide</Link>
            </Button>
          </CardContent>
        </Card>

        <div className="grid gap-4 sm:grid-cols-3">
          <InfoTile icon={KeyRound} title="API key" value="cursor-local" />
          <InfoTile
            icon={Server}
            title="Base URL"
            value="http://127.0.0.1:6903/v1"
          />
          <InfoTile
            icon={Braces}
            title="Models"
            value="composer-2.5 / composer-2.5-fast"
          />
        </div>
      </section>

      <section className="grid gap-4 py-10 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <h2 className="mb-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
            Windows-native control plane.
          </h2>
          <p className="max-w-xl text-base leading-7 text-muted-foreground">
            The CLI stores settings in AppData, encrypts the API key, manages
            PID state, and preserves configuration during updates.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <InfoTile
            icon={Shield}
            title="Encrypted key"
            value="%APPDATA%\\cursor-api\\api-key.enc"
          />
          <InfoTile
            icon={Cpu}
            title="Daemon state"
            value="%APPDATA%\\cursor-api\\run\\"
          />
          <InfoTile
            icon={Terminal}
            title="Logs"
            value="%APPDATA%\\cursor-api\\logs\\"
          />
        </div>
      </section>
    </main>
  );
}

function FeatureIcon({ index }: { index: number }) {
  const icons = [PlugZap, Bot, Server, Terminal] as const;
  const Icon = icons[index] ?? PlugZap;

  return <Icon className="size-4" />;
}

function CommandLine({ value }: { value: string }) {
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
    <div className="group/line flex items-start gap-3">
      <span className="select-none text-muted-foreground">$</span>
      <span className="min-w-0 flex-1 break-all text-foreground">{value}</span>
      <button
        className="inline-flex items-center gap-1 rounded-md border border-border bg-background/80 px-2 py-1 font-sans text-[0.68rem] font-medium text-muted-foreground opacity-100 transition hover:text-foreground sm:opacity-0 sm:group-hover/line:opacity-100"
        onClick={copyValue}
        type="button"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function InfoTile({
  icon: Icon,
  title,
  value,
}: {
  icon: LucideIcon;
  title: string;
  value: string;
}) {
  return (
    <Card className="rounded-[1.15rem] border-border bg-card/86 shadow-none transition-transform hover:-translate-y-1">
      <CardContent className="space-y-4 p-5">
        <Icon className="size-5 text-[var(--lagoon)]" />
        <div>
          <h3 className="mb-2 text-sm font-semibold">{title}</h3>
          <p className="m-0 break-words font-mono text-xs leading-5 text-muted-foreground">
            {value}
          </p>
        </div>
        <CheckCircle2 className="size-4 text-[#28a948]" />
      </CardContent>
    </Card>
  );
}
