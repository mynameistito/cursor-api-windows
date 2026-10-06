import { Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";

import { ThemeToggle } from "./theme-toggle";

const repoUrl = "https://github.com/mynameistito/cursor-api-windows";

/**
 * Renders the primary navigation and theme control.
 * @returns The site header.
 */
export const Header = () => (
  <header className="border-border bg-background/85 sticky top-0 z-50 border-b px-4 backdrop-blur-xl">
    <nav className="mx-auto flex h-16 w-full max-w-[1200px] items-center gap-3">
      <h2 className="m-0 flex-shrink-0 text-base font-semibold tracking-tight">
        <Link
          to="/"
          className="border-border bg-background text-foreground inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm no-underline shadow-sm"
        >
          <span className="bg-ring h-2 w-2 rounded-full" />
          cursor-api-windows
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
            <ExternalLink className="size-4" />
            GitHub
          </a>
        </Button>

        <ThemeToggle />
      </div>
    </nav>
  </header>
);
