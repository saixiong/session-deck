# Session Deck

A favorites dashboard for [Claude Code](https://claude.com/claude-code) sessions in VS Code: star the
sessions you keep coming back to, review where each one stands, and jump back in with the next
step already typed.

> **Status: P0 scaffold.** The dashboard shell opens and renders from your theme; the session index,
> favorites, and review features arrive in the phases listed in [docs/SPEC.md](docs/SPEC.md).

Session Deck is an independent project and is not affiliated with Anthropic.

## Develop

```bash
pnpm install
pnpm build        # or `pnpm watch`
# F5 in VS Code → "Run Extension" → ⌘⇧⌥D or "Session Deck: Open Dashboard"

pnpm check        # typecheck + lint + unit tests + build
pnpm test:e2e     # downloads a VS Code build and runs the smoke suite inside it
pnpm package      # builds a .vsix
```

Session Deck only **reads** `~/.claude/projects`. Everything it writes lives in `~/.session-deck/`
(configurable via `sessionDeck.dataDir`).
