[简体中文](README.md) | [English](README.en.md)

# DSSE

A client-side web search and page-reading tool for DeepSeek, built with Vue 3 and Vite.

## Local development

```bash
pnpm install
pnpm dev
```

After starting the app, enter a DeepSeek API Key in the account settings. The application
does not read or embed `VITE_DEEPSEEK_API_KEY`. If browser storage is unavailable, the key
can still be used for the current page session.

## Features

- Calls `POST /v1/tools/search` with date, language, site, and result-count filters.
- Supports search operators including `site:`, `-site:`, `"phrase"`, `lang:`, `after:`,
  and `before:`.
- Calls `POST /v1/tools/fetch` on demand to read a result as Markdown.
- Reuses search and page results within the current browser session to avoid duplicate requests.
- Sends requests only after an explicit user action; there are no suggestion requests or
  background polling.
- Includes Simplified Chinese, English, Japanese, Korean, Spanish, French, and German
  interfaces. The language is detected from the browser and the user's choice is remembered.

## Build

```bash
pnpm build
pnpm preview
```

Production builds reject `VITE_DEEPSEEK_API_KEY` so the key cannot be inlined into public
JavaScript.

This is a client-side application, so a key entered by the user is still sent directly to
DeepSeek. For public deployments, use a backend proxy instead of distributing a reusable
API key to visitors.

## Deploying to GitHub Pages

The repository includes `.github/workflows/deploy-pages.yml`. Pushing to `main` automatically
builds and deploys `dist`; the workflow can also be started manually from the Actions page.

For the first deployment, open **Settings → Pages → Build and deployment** in the repository
and set Source to **GitHub Actions**. The workflow uses `actions/configure-pages` to configure
the repository subpath automatically, so both project pages and custom domains are supported.
