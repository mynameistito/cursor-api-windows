const repoUrl = "https://github.com/mynameistito/cursor-api-windows";
const year = new Date().getFullYear();

/**
 * Renders the site footer with project attribution and the local API URL.
 * @returns The site footer.
 */
export const Footer = () => (
  <footer className="border-border text-muted-foreground mt-24 border-t px-4 pt-10 pb-14">
    <div className="mx-auto flex w-full max-w-[1200px] flex-col items-center justify-between gap-4 text-center sm:flex-row sm:text-left">
      <p className="m-0 text-sm">
        &copy; {year}{" "}
        <a
          href={repoUrl}
          className="text-foreground no-underline hover:underline"
          target="_blank"
          rel="noreferrer"
        >
          cursor-api for Windows
        </a>
        . All rights reserved.
      </p>
      <p className="text-muted-foreground m-0 font-mono text-xs">
        http://127.0.0.1:6903/v1
      </p>
    </div>
  </footer>
);
