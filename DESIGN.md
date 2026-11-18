# COGNEXA — design decisions (checklist)

Agreed with Mohammad Danish, 18 Nov 2026. Each line is a requirement; tick it when built and tested.
General rule: every rule has a sensible default, and the institute can change it in settings.

## 1. Look and feel
- [x] "Answer script" theme: ruled lines, red margin, roll-number boxes, three inks
      (graphite = AI, green = faculty, marker yellow = student; examiner red for marks).
- [x] Logo: open "C" with three dots meeting at a nexus. Wordmark COGNEXA.
      Tagline "Beyond assessment. Towards learning." Philosophy "AI recommends. Faculty decides. Student learns."
- [ ] Convocation (maroon + gold) kept as a possible second theme later.

## 2. Login
- [x] One login page; tabs Student / Faculty and staff / Institute admin change only the labels.
- [x] Institute code = AICTE ID (e.g. 1-7216281).
- [x] Student username = university roll no (college roll no if the university one is not issued yet).
- [x] Common first password set by the institute (e.g. EIT@12345); first login forces the student to set their own.
- [x] No self-service reset. "Forgot password" sends a request (email later) to the class coordinator;
      admin, registrar and class coordinator can all reset.
- [ ] Desktop/laptop only for tests; mobile shows "take this test on a lab computer".

## 3. Roles
- [x] Admin: institute profile, letterhead, paper format, departments, programmes, scheme (subjects, COs, RBTL),
      faculty list, sections, allotment. HOD cannot edit these.
- [x] Faculty list: employee ID, name, department, designation; role dropdown default Faculty,
      can be HOD / Dean / Director / Registrar / Nodal (additional role, still teaches).
- [x] Registrar: all student data (upload, single add, edit details each semester, promotion, detained/left).
      Upload = add new roll nos, update existing, no duplicates; summary "55 before, 6 added, 61 now";
      registrar approves the list. Student list is then visible to every department.
- [x] Section change allowed only in the first year; marks stay with the paper.
- [x] Class coordinator per section (set by admin): sees section students, resets passwords, sees missed tests.
- [x] HOD picks DQAC members from department faculty (can change any time). (Assigning papers for review: phase 3.)
- [x] Allotment rows: faculty × subject × section (one faculty many sections; one subject different faculty per section).
- [ ] HOD decides per subject who sets the paper and whether it is common or per section.
      Each section's faculty approves that section's answer scripts.

## 4. Academic structure
- [x] Academic session (e.g. 2026-27 Odd) at the top; scheme, sections, students belong to a session.
- [x] Scheme upload: subject code, name, semester, type (Theory/Lab/Elective + elective group), credits, COs with RBTL level.
- [x] Electives: default whole section; optional "elective choices" sheet (roll no, subject code) for split electives.
- [x] Promotion by registrar at session end (promote / detained / left).

## 5. Faculty: creating a paper
- [ ] Subject × section dropdown from allotment only; programme, semester, HOD, COs filled in.
- [ ] Paper structure (parts, questions, sub-parts, attempt any N, max marks) — built.
- [ ] Two ways: live form, or Excel template (Part, Q.No, Sub-part, Type, Question, CO, RBTL, Marks,
      Options A–D, Correct, Model answer, Rubric "criterion=marks; …") → preview → create.
- [ ] CO and RBTL from dropdowns; check: each CO used has at least one question at the CO's highest RBTL —
      otherwise an alert for DQAC (DQAC may accept or ask for change).
- [ ] AI suggests a rubric when the question/model answer is typed; faculty edits and saves.
- [ ] Diagrams are explained in words (no drawing pad). CS only for now (no equations/circuits).
- [ ] Draft autosave; versions v1, v2… kept.
- [ ] MCQ tests: no approval. Sessional, Mid Term, Assignment: DQAC + HOD approval before students see it.

## 6. Moderation (format A51, without A51-F dispatch and CoE)
- [ ] A51-A Submit for review → paper locked; only author, assigned DQAC members, HOD can open; views logged.
- [ ] A51-B Each assigned member (not the author) fills the 10-point checklist (Yes/No, observation, action)
      and decision (overall status, resubmit Y/N, due date, remarks).
- [ ] A51-C Faculty answers each remark (what changed, question ref) + declaration; DQAC verifies.
- [ ] A51-D Re-submission recorded as a new version with differences.
- [ ] A51-E HOD verifies compliance and approves → paper can be published.
- [ ] A51-G Master tracker on HOD dashboard (Initial → Moderated → Compliance → Re-submitted → HoD).
- [ ] Signatures: image per person (own profile, or uploaded by HOD); printed only when that person
      approved/reviewed from their own login. Full A51 file as PDF on letterhead.

## 7. Student: taking a test
- [ ] CBT layout like JEE/NTA: one question per screen, palette (answered / not answered / marked for review).
- [ ] Code answers in a monospace code box (no run); LLM/SLM checks it.
- [ ] Faculty starts the test; a 4-character start code (letters+digits, no 0/O/1/I) on the faculty screen,
      changing every 5 minutes (setting 5/10), told verbally to the lab.
- [ ] Full screen on start; leaving full screen / switching tab is warned and recorded.
- [ ] Autosave every 10 seconds; resume on another computer; same timer for all (no extra time).
      Re-test for one student: later.

## 8. Results
- [ ] Marks per question, rubric breakdown, missing points, suggestions, model answer.
- [ ] Rank (ties share a rank: 1, 1, 3). Default section-wise; approver can switch to branch-wise.
      Rank shown only after the whole section's result is approved. No class average.
- [ ] Preparedness score (0–100) and CO bands (Strong / Developing / Needs work).
- [ ] Re-check claim within 7 days per question; faculty explains or moderates marks, even after declaration; logged.
- [ ] Notification bell (free). Email later on Workers Paid (≈₹900–1,000/month at institute scale).

## 9. Reports
- [ ] Faculty: marks sheet, question-wise analysis, CO summary (% students achieving each CO).
- [ ] HOD: A51 tracker and file, A53 rank sheet (CT-wise and aggregate, Total, %, Pass/Fail at 40%, Rank),
      section toppers, pending work.
- [ ] Admin/Director: institute summary, department-wise.
- [ ] Later: CO attainment levels (institute formula), theory/lab evaluation sheets (internal marks), lab marks.
