import { TanStackDevtools } from "@tanstack/react-devtools";
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";

import { Footer } from "../components/footer";
import { Header } from "../components/header";

import appCss from "../styles.css?url";

const siteUrl = "https://cursor-api-windows.mynameistito.com";
const siteTitle = "cursor-api for Windows | Local OpenAI-Compatible Cursor API";
const siteDescription =
  "Run a Windows CLI daemon that exposes Cursor Composer through a local OpenAI-compatible API.";
const ogImageUrl = `${siteUrl}/og-image.png`;

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

const RootDocument = ({ children }: { children: React.ReactNode }) => {
  const showDevtools = import.meta.env.DEV;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script>{THEME_INIT_SCRIPT}</script>
        <HeadContent />
      </head>
      <body className="selection:bg-primary/10 font-sans [overflow-wrap:anywhere] antialiased">
        <Header />
        {children}
        <Footer />
        {showDevtools ? (
          <TanStackDevtools
            config={{
              position: "bottom-right",
            }}
            plugins={[
              {
                name: "Tanstack Router",
                render: <TanStackRouterDevtoolsPanel />,
              },
            ]}
          />
        ) : null}
        <Scripts />
      </body>
    </html>
  );
};

export const Route = createRootRoute({
  head: () => ({
    links: [
      {
        href: appCss,
        rel: "stylesheet",
      },
    ],
    meta: [
      {
        charSet: "utf-8",
      },
      {
        content: "width=device-width, initial-scale=1",
        name: "viewport",
      },
      {
        title: siteTitle,
      },
      {
        content: siteDescription,
        name: "description",
      },
      {
        content: siteTitle,
        property: "og:title",
      },
      {
        content: siteDescription,
        property: "og:description",
      },
      {
        content: "website",
        property: "og:type",
      },
      {
        content: siteUrl,
        property: "og:url",
      },
      {
        content: ogImageUrl,
        property: "og:image",
      },
      {
        content: "1200",
        property: "og:image:width",
      },
      {
        content: "630",
        property: "og:image:height",
      },
      {
        content: "cursor-api for Windows preview card",
        property: "og:image:alt",
      },
      {
        content: "summary_large_image",
        name: "twitter:card",
      },
      {
        content: siteUrl,
        name: "twitter:url",
      },
      {
        content: siteTitle,
        name: "twitter:title",
      },
      {
        content: siteDescription,
        name: "twitter:description",
      },
      {
        content: ogImageUrl,
        name: "twitter:image",
      },
    ],
  }),
  shellComponent: RootDocument,
});
