## Auto mode boundaries (set Oct 11, 2026)
Auto mode is allowed for code, tests, evals, and file work inside this repo.
Always stop and ask the Captain first for:
1. Any change to OUTBOUND_MODE or EMAIL_MODE (live texts and emails from the A2P-registered number)
2. git push, or any gh command
3. npx supabase db push
4. Reading or printing anything in .env.local
These are enforced as "ask" rules in .claude/settings.json. Never work around them with another form of the same command.
