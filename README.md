# Assessment Portal (POC)

Online assessment for assignments, sessionals and tutorials. Faculty set questions with marks and a rubric,
students type their answers in a timed window, an LLM drafts rubric-wise marks and feedback, and the faculty
approves or moderates before the result is released.

## What this POC covers

- **Faculty:** first-time account setup, add students, create an assessment (subject, code, type, number,
  window, duration, questions, CO, model answer, rubric), publish, review each submission, edit marks, approve.
- **Student:** timed attempt with autosave, paste blocked, tab switches recorded, result with marks,
  rubric breakdown, missing points and improvement suggestions.
- **Result release:** Sessional results always wait for faculty approval. Assignments and Tutorials can be set
  to "Instant", which releases right after evaluation unless the model is unsure about any answer.
- **Evaluation providers** (`EVAL_PROVIDER` in `wrangler.jsonc`):
  - `workers-ai`: Cloudflare Workers AI (default)
  - `openai-compatible`: any OpenAI-style endpoint, e.g. a model on the college server
    (set `LLM_BASE_URL`, `LLM_MODEL`, optional secret `LLM_API_KEY`)
  - `mock`: dummy keyword scorer for offline UI testing. Not a real evaluation.

Not in the POC yet: admin panel and master data, sections, analytics and CO attainment export, code questions,
multi-institute support.

## Try it offline (no Cloudflare login)

```
npm install
npm run dev:mock
```

Open http://localhost:8787. Marks come from the mock scorer and are labelled `[MOCK]`.

## Deploy on Cloudflare

```
npx wrangler login
npx wrangler d1 create assessment-portal     # copy the database_id into wrangler.jsonc
npx wrangler deploy
```

Tables are created automatically on the first visit. The first visitor is asked to create the faculty account,
so open the site and complete setup immediately after deploying.

## Layout

- `src/index.js`: API (auth, assessments, attempts, review)
- `src/evaluator.js`: prompt, provider switch, clamping of model output to the rubric
- `src/schema.js`: D1 tables
- `public/`: frontend (plain HTML, CSS, JS; no build step)
