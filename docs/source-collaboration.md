# Collaborative annotations and source comparison

Open **Sources → Read & discuss** on a processed source. The reader shows extracted indexed text,
not a PDF viewer. Select text within one passage (up to 4,000 characters), add a comment, and optionally
choose teammates under **@ Mention teammates**. Discussions are shared with every workspace member.
Replies can mention teammates too. The author or a workspace admin/owner can resolve and reopen a
discussion. Resolved discussions remain available with **Show resolved**.

Mentions are stored in the database and shown in **Your mentions** on Sources, including those received
while offline. Opening a mention marks it read. The inbox shows the latest 50 mentions, unread first.
Discussions refresh every five seconds and the inbox every ten seconds while the tools are open.
There are no email or push notifications.

Highlights save the original passage and UTF-16 selection offsets. If a source is reindexed and that
passage changes or disappears, the discussion is marked stale and preserves the original quote; the
highlight is not applied to unrelated replacement text. Source deletion removes its discussions and
mentions through foreign keys. Account deletion preserves discussion text with an anonymous author.

## Compare sources

Choose **Compare sources**, select two processed documents, and optionally enter a focus. The AI
compares balanced samples (up to 12 passages and 18,000 characters per document, at most 2,500 characters
per passage), even if a document is switched off for general workspace chat. Agreements and contradictions
require citations from both respective documents. A gap requires a citation from one document and is
explicitly limited to absence in the reviewed passages. Coverage counts and sampling warnings accompany
every result. Citation buttons open the corresponding extracted passage for reading and annotation.
An expandable view also lets users read the selected documents side by side.

The comparison uses the existing Research model route and usage accounting. Findings with invalid or
wrong-document citation indices are withheld. Valid citation indices establish the source location,
not semantic correctness: users should review the evidence. Comparisons are not saved across page reloads.

## Setup

Apply `supabase/migrations/20261014000000_source_collaboration.sql` through the normal migration workflow,
then restart/redeploy the backend, AI service, and frontend. Do not rerun the migration manually after it
has been applied. No new runtime packages or secrets are needed. Comparison requires the existing model
provider credentials; reading, annotations, and mentions do not require a model call.

The tables use the existing backend-only authorization model with RLS enabled and no browser policies.
REST endpoints check authentication, workspace membership, and source/discussion scope. Writes have
per-user rate limits (`ANNOTATION_RATE_LIMIT_PER_MIN`, default 30); comparison shares the existing
`AI_TOOL_RATE_LIMIT_PER_MIN` budget. The backend alone supplies workspace and caller IDs to the AI service.

## Verification

- Backend: `node --test test/sourceCollaboration.test.js`, plus the existing `npm test` suites.
- AI: `python -m pytest tests/test_comparison.py tests/test_generator.py tests/test_api.py -q`.
- Frontend: TypeScript, ESLint, `npm test`, and production build.
- With a migrated test database: two members should create/reply/mention, reload, resolve/reopen,
  follow citations, and compare sources; a third user outside the workspace must have no access.
