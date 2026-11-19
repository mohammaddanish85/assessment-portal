# COGNEXA: Cognitive Nexus for Assessment

Beyond assessment. Towards learning. AI recommends, faculty decides, student learns.

An online assessment portal for institutes. Faculty set questions with marks and a rubric, students type their
answers in a timed window, an LLM drafts rubric-wise marks and feedback, and the faculty approves or moderates
before the result is released.

## Who uses it

- **Platform owner:** sees access requests from the home page, creates institutes (code = AICTE ID) and their
  admin logins, suspends or activates an institute. Has no access to an institute's internal data.
- **Institute admin:** Institute setup checklist: profile and rules (session, first password, pass mark, rank
  scope, start-code interval, letterhead, paper format, internal-marks scheme, lab rubric), departments,
  programmes, scheme with COs and Bloom levels, faculty with roles, sections with class coordinators, subject
  allotment. Every list can be uploaded from Excel with a preview (new / update / no change / to fix).
- **Registrar:** owns the student list: approve and import, add one, edit, detained / left, promote a section.
- **HOD:** DQAC committee, who sets each subject's paper (each section or one common paper), assigns papers for
  moderation, approves papers (A51), A51-G tracker, rank sheets, department results.
- **DQAC member:** reviews assigned papers with the A51-B checklist and question-wise comments.
- **Faculty:** papers for allotted subjects, results of their own sections, re-checks, evaluation sheets.
- **Class coordinator:** the section's students, password-reset requests, rank sheet.
- **Dean / Director / Nodal:** institute-wide reports.
- **Students:** lab tests with a start code, results with rank, CO bands and model answers, re-check requests.

People log in with institute code, username (employee ID or university roll no) and password. New accounts get
the institute's first password and must set their own at first login; students cannot change it afterwards
(the class coordinator, registrar or admin resets it). Pages: `/` is the public home page; `/portal` is the app.
The full list of agreed rules is in `DESIGN.md`.

## What it covers

- **Papers:** five types (Mid Term, Sessional, Assignment, MCQ Test, Hybrid) with a faculty-defined structure
  (parts, sub-parts, "attempt any N", max marks); CO and Bloom level per question from the scheme with a
  CO-level check; questions typed or filled from an Excel template; AI-suggested rubrics; printed in the
  institute's own format on its letterhead.
- **Moderation (A51):** Mid Term, Sessional, Assignment and Hybrid papers go to the DQAC and the HOD before they
  can be published; versions, compliance, view log and a printable A51 file with signatures.
- **Tests:** JEE/NTA-style screen with a question palette, code box, 4-character start code from the faculty's
  screen, full screen, phones refused, autosave every 10 seconds, resume on another computer.
- **Evaluation:** MCQs against the key (optional negative marking); written answers by the LLM against the
  rubric; the section's faculty approves. Best-of counting for choice parts.
- **Results:** marks, rubric breakdown, missing points, suggestions, model answer, rank (ties share), preparedness
  score, CO bands; re-check within 7 days; notification bell.
- **Reports:** analysis per assessment (question-wise, CO-wise % of students at target), A53 rank sheet
  (section- or branch-wise, Pass/Fail at the pass mark, toppers, Excel), institute overview.
- **Evaluation sheets:** TES (internal marks from approved results, attendance, moderation; default
  5 + 5 + 10 + 5 = 25) and LES (experiments, R1/R3/R4 rubric, average, scale to 15, moderation), Excel and print.
- **Re-test:** the section's faculty gives an absent student (or one whose test was spoilt) a personal window;
  any earlier attempt is removed with a note kept in the record.
- **Administration:** activity log, one-click Excel backup of the whole institute, a help page for every role,
  strict security headers.
- **Evaluation providers** (`EVAL_PROVIDER` in `wrangler.jsonc`):
  - `workers-ai`: Cloudflare Workers AI (default)
  - `openai-compatible`: any OpenAI-style endpoint, e.g. a model on the college server
    (set `LLM_BASE_URL`, `LLM_MODEL`, optional secret `LLM_API_KEY`)
  - `mock`: dummy keyword scorer for offline UI testing. Not a real evaluation.

Not built yet: CO attainment levels by the institute's formula, email notifications (needs the Workers Paid plan).

## Try it offline (no Cloudflare login)

```
npm install
npm run dev:mock
```

Open http://localhost:8787. Marks come from the mock scorer and are labelled `[MOCK]`.

## Deploy on Cloudflare

**From the dashboard (no commands):** Workers & Pages > Create application > import this GitHub repository,
keep the default deploy command `npx wrangler deploy`, and deploy. Every later push to `main` redeploys.

**From a terminal:**

```
npm install
npx wrangler login
npx wrangler deploy
```

The D1 database is created automatically on the first deploy and the tables on the first visit. The first visitor
is asked to create the platform owner account, so open the site and complete setup immediately after deploying.

If the deploy stops with a message about the D1 database, create it once (`npx wrangler d1 create assessment-portal`)
and add the printed `database_id` next to `database_name` in `wrangler.jsonc`.

## Layout

- `src/index.js`: API (auth, assessments, attempts, review)
- `src/evaluator.js`: prompt, provider switch, clamping of model output to the rubric
- `src/schema.js`: D1 tables
- `public/`: frontend (plain HTML, CSS, JS; no build step)
