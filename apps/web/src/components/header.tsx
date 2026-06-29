import { Link } from "@tanstack/react-router";
import { Github } from "lucide-react";

import { Button } from "@/components/ui/button";

import { ThemeToggle } from "./theme-toggle";

const repoUrl = "https://github.com/mynameistito/cursor-api-windows";

export const Header = () => (
  <header className="sticky top-0 z-50 border-b border-border bg-[var(--header-bg)] px-4 backdrop-blur-xl">
    <nav className="mx-auto flex h-16 w-full max-w-[1200px] items-center gap-3">
      <h2 className="m-0 flex-shrink-0 text-base font-semibold tracking-tight">
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground no-underline shadow-[0_2px_2px_rgba(0,0,0,0.04)]"
        >
          <span className="h-2 w-2 rounded-full bg-[#006bff]" />
          cursor-api
        </Link>
      </h2>

      <div className="hidden items-center gap-5 text-sm font-medium md:flex">
        <Link
          to="/"
          className="nav-link"
          activeProps={{ className: "nav-link is-active" }}
        >
          Home
        </Link>
        <Link
          to="/docs"
          className="nav-link"
          activeProps={{ className: "nav-link is-active" }}
        >
          Docs
        </Link>
        <a href={repoUrl} className="nav-link" target="_blank" rel="noreferrer">
          GitHub
        </a>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Button
          asChild
          size="sm"
          variant="outline"
          className="hidden sm:inline-flex md:hidden"
        >
          <a href={repoUrl} target="_blank" rel="noreferrer">
            <Github className="size-4" />
            GitHub
          </a>
        </Button>

        <ThemeToggle />
      </div>
    </nav>
  </header>
);
