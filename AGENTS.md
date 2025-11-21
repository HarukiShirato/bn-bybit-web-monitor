# Repository Guidelines

## Project Structure & Module Organization
- `app/page.tsx` renders the dashboard UI; shared UI pieces live in `components/` (filters, table, search, controls).
- `app/api/perps/route.ts` aggregates exchange data and market-cap lookups, delegating to `lib/exchanges/` (per-exchange adaptors) and `lib/marketData.ts` (CoinGecko mapping/cache).
- Styling and build config sit in `tailwind.config.js`, `postcss.config.js`, `next.config.js`, and `tsconfig.json`. Static assets are in `app/` alongside global styles (`app/globals.css`).
- Keep new utilities in `lib/`, and co-locate component-specific helpers next to the component when scope is narrow.

## Build, Test, and Development Commands
- `npm install` – install dependencies (Node 18+ recommended).
- `npm run dev` – start the Next.js dev server on `http://localhost:3000`.
- `npm run build` – production build; run before releasing.
- `npm start` – serve the production build.
- `npm run lint` – run `next lint` (TypeScript/React rules + Next/Tailwind checks); fix warnings before opening a PR.

## Coding Style & Naming Conventions
- TypeScript + functional React components; prefer `const`, hooks at the top, and early returns for clarity.
- Indentation: two spaces; keep imports ordered (React/Next, third-party, internal `@/` paths).
- Components/files: `PascalCase` (e.g., `PerpTable.tsx`); functions/variables: `camelCase`; constants: `UPPER_SNAKE_CASE`.
- Keep UI layout with Tailwind utility classes; avoid inline styles unless necessary. Reuse shared pieces from `components/` rather than duplicating markup.

## Testing Guidelines
- No automated test suite is present yet; rely on `npm run lint` plus manual smoke tests in dev for now.
- When adding tests, colocate `*.test.ts(x)` or `__tests__/` near the module, covering data transforms (exchange adapters) and component behaviors. Favor React Testing Library for UI and lightweight mocks for fetchers.
- Before submitting changes that touch data fetching, verify `/api/perps` responds without errors and key UI flows still render.

## Commit & Pull Request Guidelines
- Use clear, imperative subjects; Conventional Commit prefixes are preferred for readability (e.g., `feat: add okx adapter`, `fix: handle missing market cap`).
- Each PR should include: a short summary of the change set, commands/tests run (at least `npm run lint`), and screenshots for UI-impacting updates.
- Link related issues or tasks, call out breaking changes or new config/env needs (none required today), and mention any new dependencies introduced.

## Data & Security Notes
- All current data sources are public; do not commit credentials. If private endpoints are added later, load keys via env vars and document them in `README.md`.
- Respect exchange/CoinGecko rate limits; prefer reusing the existing cache in `lib/marketData.ts` and batching requests in new adapters.
