# CLAUDE.md

Guidance for Claude Code in this repository. See `README.md` for architecture
and `PROVENANCE.md` for what predates the hackathon.

## Development workflow: persistent servers are user-managed

The user runs and owns the persistent application servers:

| Server | Port | Command (PowerShell) |
|---|---|---|
| Frontend (Vite) | 5000 | `cd C:\Flavia\Code\NavEvolve\body; npm run dev` |
| Backend (FastAPI) | 8000 | `cd C:\Flavia\Code\NavEvolve\brain; .\.venv\Scripts\python.exe -m uvicorn server:app --port 8000` |

- **Never start, stop, restart or kill** the processes on ports 5000 or 8000.
- Temporary, isolated test processes are fine (headless browsers, a test
  server on another port such as 8010/5010) as long as they do not touch
  ports 5000/8000. Clean them up afterwards.
- When a change needs a restart (e.g. any `brain/*.py` change — the backend
  runs without `--reload` — or `brain/.env` / `vite.config.js` edits), tell
  the user **which server** to restart and give the exact PowerShell command
  above. Do not restart it yourself. Frontend source edits under `body/src`
  hot-reload and need no restart.
- Continue implementing, testing, committing and pushing as usual.

## Security

- MongoDB credentials live only in `brain/.env` (gitignored); never read them
  into output, commit them, or send them to the browser.
- Run a secret-exclusion check on staged changes before every commit/push.
