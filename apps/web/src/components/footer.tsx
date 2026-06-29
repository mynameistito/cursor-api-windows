const repoUrl = "https://github.com/mynameistito/cursor-api-windows";

export const Footer = () => {
  const year = new Date().getFullYear();

  return (
    <footer className="mt-24 border-t border-border px-4 pb-14 pt-10 text-muted-foreground">
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
        <p className="m-0 font-mono text-xs text-muted-foreground">
          http://127.0.0.1:6903/v1
        </p>
      </div>
    </footer>
  );
};
