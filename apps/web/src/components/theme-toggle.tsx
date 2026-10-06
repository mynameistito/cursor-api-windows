import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";

type ThemeMode = "light" | "dark" | "auto";

const getInitialMode = (): ThemeMode => {
  if (typeof window === "undefined") {
    return "auto";
  }

  try {
    const stored = window.localStorage.getItem("theme");
    if (stored === "light" || stored === "dark" || stored === "auto") {
      return stored;
    }
  } catch {
    return "auto";
  }

  return "auto";
};

const subscribeToThemeMode = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};

const getServerThemeMode = (): ThemeMode => "auto";

const resolveThemeMode = (mode: ThemeMode, prefersDark: boolean) => {
  if (mode !== "auto") {
    return mode;
  }

  if (prefersDark) {
    return "dark";
  }

  return "light";
};

const applyThemeMode = (mode: ThemeMode) => {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = resolveThemeMode(mode, prefersDark);

  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(resolved);

  if (mode === "auto") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = mode;
  }

  document.documentElement.style.colorScheme = resolved;
};

const getNextMode = (mode: ThemeMode): ThemeMode => {
  if (mode === "light") {
    return "dark";
  }

  if (mode === "dark") {
    return "auto";
  }

  return "light";
};

const getModeText = (mode: ThemeMode) => {
  if (mode === "auto") {
    return "Auto";
  }

  if (mode === "dark") {
    return "Dark";
  }

  return "Light";
};

const renderModeIcon = (mode: ThemeMode) => {
  if (mode === "auto") {
    return <Monitor className="size-4" />;
  }

  if (mode === "dark") {
    return <Moon className="size-4" />;
  }

  return <Sun className="size-4" />;
};

/**
 * Renders a button that cycles between light, dark, and system themes.
 * @returns The theme toggle button.
 */
export const ThemeToggle = () => {
  const mode = useSyncExternalStore(
    subscribeToThemeMode,
    getInitialMode,
    getServerThemeMode
  );

  useEffect(() => {
    applyThemeMode(mode);
  }, [mode]);

  useEffect(() => {
    if (mode !== "auto") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyThemeMode("auto");

    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, [mode]);

  const toggleMode = () => {
    const nextMode = getNextMode(mode);
    window.localStorage.setItem("theme", nextMode);
    applyThemeMode(nextMode);
    window.dispatchEvent(new StorageEvent("storage", { key: "theme" }));
  };

  const label =
    mode === "auto"
      ? "Theme mode: auto (system). Click to switch to light mode."
      : `Theme mode: ${mode}. Click to switch mode.`;

  return (
    <Button
      type="button"
      onClick={toggleMode}
      aria-label={label}
      title={label}
      size="sm"
      variant="outline"
    >
      {renderModeIcon(mode)}
      <span className="hidden sm:inline">{getModeText(mode)}</span>
    </Button>
  );
};
