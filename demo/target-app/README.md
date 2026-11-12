# Demo target app

A tiny, deliberately-failable application Server used by the SBWK end-to-end demo.
It is **not** part of the production stack — it stands in for "your app".

Routes:
- `GET /` — service info
- `GET /health` — liveness
- `GET /users` — reads from a simulated database (fails when `failMode=database`)
- `GET /external` — calls a simulated third-party API (fails when `failMode=external`)
- anything else — `404`
- `POST /_control {"mode":"normal|database|external"}` — flip the failure mode

Its source is also mounted as the read-only codebase that Agent Core inspects.
