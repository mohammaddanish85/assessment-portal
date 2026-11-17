# COGNEXA: Cognitive Nexus for Assessment

Beyond assessment. Towards learning. AI recommends, faculty decides, student learns.

An online assessment portal for institutes. Faculty set questions with marks and a rubric, students type their
answers in a timed window, an LLM drafts rubric-wise marks and feedback, and the faculty approves or moderates
before the result is released.

## Who uses it

- **Platform owner:** sees access requests from the home page, creates institutes and their admin logins,
  suspends or activates an institute. Has no access to an institute's internal data.
- **Institute admin:** institute profile (name, logo), departments, courses and sections, subjects, staff and
  students; gives each staff member a role and rights.
- **Staff rights:** manage institute setup, create assessments, approve results, and which reports they can see
  (own, whole department, whole institute). Roles (institute admin, nodal officer, head of department, faculty)
  only fill in the usual rights; the admin can change them per person.
- **Students:** take the assessments of their own section and see their results.

Every institute's data is kept apart by its institute id. People log in with institute code, username and password;
the platform owner uses the separate owner log in. A password set by someone else must be changed at first login.
A database from the earlier single-institute version is moved into institute `INST1` automatically.

Pages: `/` is the public home page with the request-access form; `/portal` is the application.

## What it covers

- **Admin:** first-time account setup; institute name, second line and logo for printed documents; master data
  (sections, subjects, faculty accounts, students in bulk per section) with edit and delete; password reset.
- **Faculty:** create an assessment (subject from master data, sections, type, number, window, duration, questions,
  CO, model answer, rubric), publish, review each submission, edit marks, approve.
- **Student:** sees only the assessments of their own section; timed attempt with autosave, paste blocked,
  tab switches recorded; result with marks, rubric breakdown, missing points and improvement suggestions.
- **MCQ:** any question can be an MCQ (2 to 6 options, one correct), checked against the answer key without the LLM.
  The "MCQ Test" assessment type allows only MCQs and shows the result the moment the student submits.
- **Result release:** Sessional results always wait for faculty approval. Assignments and Tutorials can be set
  to "Instant", which releases right after evaluation unless the model is unsure about any answer.
- **Analysis (published results only):** class average, highest, lowest, question-wise average, CO-wise average and
  count of students at or above a target the faculty sets, and a marks download (CSV, opens in Excel).
- **Documents for records:** print-ready A4 pages for the assessment report, question paper, paper with answer key
  and rubric, and evaluated answer sheets (one student or the whole class). Use "Print / Save as PDF" on the page.
- **Evaluation providers** (`EVAL_PROVIDER` in `wrangler.jsonc`):
  - `workers-ai`: Cloudflare Workers AI (default)
  - `openai-compatible`: any OpenAI-style endpoint, e.g. a model on the college server
    (set `LLM_BASE_URL`, `LLM_MODEL`, optional secret `LLM_API_KEY`)
  - `mock`: dummy keyword scorer for offline UI testing. Not a real evaluation.

Faculty can also shuffle the question order per student and delete an assessment until a student starts it.

Not built yet: editing a saved assessment, code questions, multi-institute support.

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
