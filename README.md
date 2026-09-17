# ShopAI

Family assistant for groceries and shopping: shared list, meal planning,
Albert Heijn basket filling, and non-grocery product search on bol.com and
Amazon.nl. Controlled from Telegram and a small web page. Powered by the
in-house ZillaAGI (ZAGI) model.

The bot never pays. It fills the basket; a human checks out.

- Architecture and module plan: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Operations: [docs/OPERATIONS.md](docs/OPERATIONS.md); Albert Heijn notes:
  [docs/STORE-AH.md](docs/STORE-AH.md); web search / marketplaces:
  [docs/WEB.md](docs/WEB.md)
- Stack: Node 22, TypeScript, pnpm workspaces, grammY, Fastify, React + Vite,
  Postgres 16 with Drizzle, Docker Compose.

Status: Phase 1 (list) and Phase 2 (Albert Heijn search, one-tap add links)
deployed; web layer (internet search, page reads, bol.com / Amazon.nl
discovery, Amazon cart links) built. Web page UI and meal planning pending.
