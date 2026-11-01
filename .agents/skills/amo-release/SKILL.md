---
name: amo-release
description: Prepare CHZZK Catch-up Firefox store releases, bilingual release notes and reviewer notes, and diagnose this repository's AMO submission workflow.
---

Read `amo/README.md` for repository-specific commands, secrets, approval setup and recovery. The workflow is `.github/workflows/amo-release.yml`; metadata preparation is `tools/amo-prepare.mjs`.

Keep the existing add-on ID `chzzk-catchup-firefox@local`. Releases use vX.Y.Z tags, GitHub Actions and the manually approved amo-production environment. Do not cancel or replace a version awaiting Mozilla review. Do not confuse successful submission with approval/publication.

When preparing a release, inspect the diff since the previous release and the actual manifest and scripts. Preserve existing user edits. Ask the user and stop if the target version or needed facts are unclear. Do not invent successful Firefox/CHZZK runtime verification.

Create `amo/releases/X.Y.Z/notes.ko.md`, `notes.en.md`, `reviewer.md` (English) and `release.json` with reviewed=false and updateListing=false. Draft public notes for users; put permission changes, page bridges, test instructions and limitations in reviewer.md. Common reviewer text comes from amo/reviewer-common.md. Update it if actual implementation changes. Keep credentials out of all text; the repository is public.

Present the concrete proposed text for user review. Set reviewed=true only after the user confirms that release's text. Update manifest.json and package.json together without overwriting unrelated edits. Store listing text changes only when explicitly requested: edit amo/summary.ko.txt and summary.en.txt for the short summaries, amo/listing.ko.md and listing.en.md for full descriptions, and set updateListing=true for that release. That switch updates both summary and description, so review both languages of both fields.

Run repository tests/checks and metadata preparation, then lint the staged extension. Summarize the package, text and validation before any requested tag push. Pushing a version tag starts the workflow; GitHub approval is the final submission gate. Preparation alone does not authorize pushing a release tag. Never auto-approve the deployment.

On upload failure, first inspect AMO for whether the version already exists. Stop rather than blindly resubmit or delete a version. If only the description PATCH failed, recover that metadata separately; do not rerun the submission job.
