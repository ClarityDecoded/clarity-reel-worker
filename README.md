# Reel worker

Turns an Instagram reel link into a structured, searchable result: resolve →
download → ffmpeg → speech-to-text → on-screen-text OCR → one structuring pass
→ a recipe or a synopsis. Runs on GitHub Actions on a schedule and emails a
single digest each morning.

It is the background half of a private app; this repo holds only the worker.
There is no data here — every run reads and writes a Supabase project the repo
does not own, reached through repository secrets.

## Layout

    worker/            the pipeline (plain .mjs, Node 22+, two dependencies)
    .github/workflows  the schedules

## Running it

Needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`, at least one AI provider key
(`NVIDIA_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `CEREBRAS_API_KEY`,
`OPENROUTER_API_KEY` — the router uses whichever exist and fails over between
them), and `RESEND_API_KEY` for the digest. See `worker/.env.example`.

    cd worker && npm install
    MODE=process npm start        # drain the queue
    MODE=digest npm start         # send the digest

## Logs

Actions logs on a public repo are public, so these jobs set `PUBLIC_LOGS=1` and
`worker/log-privacy.mjs` redacts urls, titles and extracted text from every log
line. Leave it on.

## Licence

No licence — all rights reserved. Public for free CI, not as a template.
