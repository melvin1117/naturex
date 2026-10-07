# ADR-0006: Listing verification: transparent checks now, a real-world path later

## Status
Proposed (2026-10-07). Builds on [ADR-0005](./0005-accounts-roles-and-two-apps.md) (accounts, communities, roles) and changes [pm-spec](../specs/pm-spec.md) (story A9), [dev-spec](../specs/dev-spec.md) §5, §6 and §15, and [demo-plan](../specs/demo-plan.md) §3.

## Date
2026-10-07

## Context
- **Who may list a piece of land, and on whose behalf?**
  - ADR-0005 lets any signed-in user register a community and list land.
  - Today the only safeguards are an attestation checkbox, the polygon overlap check and admin suspension.
  - That stops accidents but not someone who lies.
- **We can't prove ownership automatically.**
  - Real markets rely on land registries, legal entities, community consent and accredited third-party verifiers.
  - None of those has an open API we could call during a hackathon.
- **What we can do is two things:**
  - make every check we *do* run visible;
  - say plainly what we *don't* check yet.

  A "Verified ✓" badge with no explanation would be a black box. Judges and investors should be able to see how a listing was verified, by whom (role) and when.

## Decision

### 1. Verification is a separate track from the listing status
- A listing has a **status** (draft → rating → listed …, ADR-0005 / T58) and, separately, a **verification level**:

| Level | Meaning | How it's reached |
|---|---|---|
| `unverified` | Only the steward's attestation | Default |
| `documents_submitted` | Evidence uploaded and the automated checks have run | Steward uploads evidence (§2) |
| `verified` | A named reviewer role approved it after reading the checks | Admin or partner reviewer approves (§3) |
| `rejected` | The reviewer found a problem; the reasons are shown to the steward | Reviewer rejects with reasons |
| `revoked` | An approved listing was later found wrong (dispute, new evidence) | Admin revokes with reasons; **trading is suspended at once** |

- **Verification runs are write-once records.** The checklist, fingerprint, document links and method version never change. A decision is written once (`documents_submitted` → `verified` or `rejected`; `verified` → `revoked`), and `is_current` only flips when a newer run supersedes it. A database trigger enforces this, and the ledger keeps every decision append-only. Each run stores an **input fingerprint**: a hash of the community, the listing name, the geometry, the area, the document commitments and the method version.
- **One run is current per asset**, enforced with a partial unique index.
- **Changes reset verification:** if the polygon, area, name, community or documents change afterwards, the fingerprint no longer matches and the listing counts as `unverified` until a new run is approved.
- **The IPO is gated:** in the live world, the IPO transaction locks the asset and needs the current run to be `verified` with a matching fingerprint.
- **Revoking** atomically marks the run `revoked` and suspends the asset. Orders are rejected, the public panel says "Verification revoked", and both changes go into the ledger. Trading resumes only after a new run is approved.
- Rating and browsing work at any level.
- **Sandbox worlds** start the curated sites as `verified` by a seeded demo reviewer, and also include one unverified listing, so judges can see both.

### 2. Evidence and automated checks: every result is shown
The steward uploads up to 3 documents, for example:
- a land title or agrarian certificate;
- the community assembly's minutes approving the listing;
- the cooperative or ejido registration.

Each run produces a **checklist**, stored with the result and shown to the reviewer and steward. Each item has a pass, warn or fail, the value it found and where it came from.

| Check | How | Type |
|---|---|---|
| Accepted file format | MIME allowlist (PDF, JPEG, PNG), magic bytes, ≤ 5 MB, decoded-pixel and PDF page/object limits; encrypted or malformed PDFs rejected | Deterministic |
| Not reused | A per-world keyed fingerprint of the file is bound to one asset (database constraint): the same document can't back two listings, but the same listing can reuse it in a later run | Deterministic |
| Boundary is free | No overlap with another listing in this world (T36/T58) | Deterministic |
| Consent-labelled document attached | The steward attached a document labelled "assembly minutes / consent". This shows a document was attached, **not** that consent exists | Deterministic |
| Extracted fields consistent with listing *(Should, T71)* | MiniCPM-V extracts holder name, parcel ID, place, area and issue date. Nemotron compares them with the listing: community name, municipality or state (Nominatim reverse geocode of the centroid), and area within ±20%. Each comparison shows both values and the source excerpt | AI heuristic |
| **Not checked** (shown on every public panel) | Whether the document is authentic or forged; whether the issuing authority is real and the title is current; legal validity and signatures; quorum, language and validity of community consent (FPIC); whether the drawn polygon matches the legal parcel; who the uploader really is; registry records | Disclosure |

- **The AI only suggests, and its output is treated as attacker-controlled.** A document can contain instructions aimed at the model.
  - The call has no tools, no secrets and no other tenants' data, and it can't change any check or the verification level.
  - Output is schema-validated.
  - Reviewers see it labelled "untrusted heuristic", next to the source excerpts.
  - Tests use adversarial PDFs and images.

  This follows AGENTS.md: the LLM classifies and explains, and deterministic code and humans decide. If time runs short, T71 is cut and the deterministic checks stay.
- **Files are hostile until proven otherwise.**
  - Parsing (PDF rasterising, image decoding) runs in a worker with a timeout and resource limits.
  - Reviewers and the AI see re-encoded PNG previews, never the original bytes.
  - Downloads are served with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.

### 3. A human reviewer decides, and the decision is on the record
- A reviewer (admin in the hackathon; an accredited partner later) sees:
  - the documents;
  - the checklist;
  - the AI's reasons;
  - the map with the polygon.
- They approve or reject, and must write a reason when rejecting.
- **The Nature Ledger gets a `verification` entry for each decision**, containing:
  - the level;
  - the reviewer's role (`platform_admin` / `partner_reviewer`), never a name;
  - the method version;
  - the checklist result (pass/warn/fail per check);
  - the run's input fingerprint;
  - a **randomized commitment** per document: SHA-256 of a private random nonce plus the file.

  It never contains the documents, raw document hashes, names or account IDs. Raw hashes would let anyone holding a copy confirm it against the permanent public ledger, even after we delete the document. With the nonce kept private, the commitment proves the document set didn't change after review; we can reveal the nonce alongside a document when selective verification is wanted. Deleting the nonce makes the commitment unlinkable.

### 4. Public transparency: "How this listing was verified"
Every asset page in the Exchange has a panel showing:
- the verification level and the date;
- the reviewer role;
- each check with its result;
- what was **not** checked, from the disclosure row above;
- a link to the matching ledger entry.

The badge text is precise:
- `verified`: "Documents reviewed by NatureX (hackathon process)";
- `unverified`: "Self-attested by the community".

It never says "Ownership proven".

### 5. Privacy, access and file safety
- **Classification:** raw documents and extracted fields (holder names, parcel IDs) are **sensitive personal data**. Purpose: verifying the right to list one piece of land. Uploaders confirm they're authorised to share the document, and are told it's processed by an AI model on Nebius Token Factory.
- **Access:**
  - Documents live in private storage under generated names; `storage_key` is never exposed.
  - Only `GET /assets/{id}/documents/{doc_id}` serves them. It loads by `(world_id, asset_id, id)` and allows only that community's members and same-world admins; everyone else gets 404.
  - Tests cover investors, non-members, other communities, other worlds and anonymous users.
  - Uploads are protected by the T66 CSRF rule and the T57 authorization route test.
- **Database isolation (ADR-0005):** `uploaded_by` and `reviewer_user_id` use composite `(world_id, user_id)` foreign keys, and a document can link only to a run of its own asset (a `(world_id, asset_id, run_id)` foreign key).
- **Retention and deletion:**
  - Documents and extracted fields are kept while the listing exists, and deleted 30 days after the listing is deleted.
  - That includes the object, `extracted` JSON, previews and failed-job artefacts.
  - Account deletion (K5) anonymises the uploader and keeps the community's evidence, because it belongs to the community, not to the person.
  - Deleting a listing also deletes the commitment nonces, so the public ledger entries become unlinkable.
- **LLM processing (T71):**
  - Previews and extracted text go to Nebius Token Factory. **In the live world it stays off** (`VERIFICATION_AI_LIVE=false`) until Token Factory's data retention and training terms are confirmed; sandboxes use seeded demo documents only, so no real person's data is sent.
  - Raw prompts and responses are never logged or traced; `llm_calls` keeps only metadata.
- **Public panel:** shows only check names, pass/warn/fail and the not-checked list; never extracted fields.

### 6. Demo verification mode (deployment, judging and E2E tests)
Nobody can upload real land papers to a hackathon deployment or a test run, so there is a **labelled demo mode**, not a hidden bypass.
- **The setting:** `VERIFICATION_MODE=review | demo`.
  - The default is `review`, the real process: a person decides.
  - The hackathon deployment, sandbox worlds and E2E tests set `demo`.
  - A real launch sets `review`, and demo mode can't be switched on for a single listing.
- **Sample documents:** in demo mode the Steward app offers **"Use sample documents (demo)"**.
  - It generates fictional documents for that listing: an agrarian certificate and assembly minutes, filled with the listing's own name, place and area.
  - Each page is watermarked **"SAMPLE: FICTIONAL DOCUMENT, NOT A REAL TITLE"**.
  - Each document is stored with `is_sample = true`.
  - No real person's data is involved.
- **The checklist still runs for real:**
  - format, not reused (each sample is generated per listing, so its fingerprint is unique), overlap and consent-labelled document;
  - in sandboxes, the T71 AI comparison too.

  That keeps the whole flow exercised end to end.
- **The demo auto-reviewer:** if every deterministic check passes, a reviewer with role `demo_auto` approves at once, with the reason "Demo mode: sample documents, all checks passed". If a check fails, the run is rejected, as in review mode. An admin can still reject or revoke.
- **Always disclosed:**
  - the run is stored with `mode = 'demo'`;
  - the ledger entry records `mode: demo` and `reviewer_role: demo_auto`;
  - the badge reads **"Demo verification: sample documents, no real ownership checked"**;
  - the public panel repeats this at the top;
  - the site footer shows "Verification: demo mode" whenever it's on.
- **Real documents are still accepted in demo mode.** Anyone who wants to try the real flow can upload, and an admin reviews them.

### 7. The real-world path (not built in the hackathon)
The same data model and checklist extend to real verification by adding check rows and reviewer roles, not by replacing the design:
1. **Registry lookup.**
   - Mexico: the Registro Agrario Nacional (RAN) for ejido and communal land; the state public property registry and cadastre for private land. Other countries have their own registries.
   - A partner with registry access confirms the parcel and the holder, giving a new check row "Registry match".
2. **Legal entity.** Confirm the community's cooperative or ejido registration and the authority of the person listing.
3. **Free, prior and informed consent (FPIC).** Assembly minutes with quorum, held in the community's language, are checked by the partner. This is the standard for indigenous and communal land.
4. **Accredited third-party verifiers.** Local NGOs or validation bodies, similar to how carbon-credit projects are validated, act as `partner_reviewer`. Each has a public profile, and their decisions are ledgered like the admin's.
5. **Public notice and objection period.** A listing is announced, for example 30 days before the IPO. Anyone can file an objection, and the reviewer must resolve it.
6. **Re-verification and disputes.** Re-verify yearly, and on any valid dispute. The fingerprint and revoke mechanics above already handle boundary changes and pausing trading.
7. **Optional anchoring.** Anchor the verification ledger entry's hash publicly (OpenTimestamps, F3) for extra assurance.

## Consequences
- **New tasks:**
  - **T69 (Must, backend core):**
    - safe upload and serving;
    - immutable runs with fingerprints and one current run;
    - the deterministic checklist;
    - reviewer decision and revoke-suspends;
    - randomized ledger commitments;
    - the live-world IPO gate;
    - authorization tests.
  - **T71 (Should, off the critical path):** the AI extraction heuristic.
  - **T70 (Must, UI):** steward upload and status; the Exchange badge and "How this listing was verified" panel; the admin review queue.
- **Schema:**
  - `verification_runs` and a private `listing_documents` table (dev-spec §5).
  - The ledger gains a `verification` kind, which needs a migration to the ledger's `kind` check constraint.
- **T59 (IPO launch):** in the live world, T69 adds the "current run verified, fingerprint matches" rule inside the IPO transaction.
- **T46 (E2E):** runs with `VERIFICATION_MODE=demo`. The real-account path uses sample documents → auto-approved → IPO, plus a revoke that suspends trading. The review-mode path (upload → admin approves) is covered by T69's tests.
- **Deployment (T20/T42):** sets `VERIFICATION_MODE=demo`, and the README and Devpost text say so.
- **Reused work:** T71 reuses the MiniCPM-V perception path from ADR-0003. It doesn't depend on T40 photo evidence; it shares the same model routing.

## Alternatives considered
- **An admin approve button only, with no checks or record.** Rejected as a black box: nobody can see why a listing was trusted.
- **Let the AI decide verification.** Rejected: an LLM reading a scanned PDF can't establish legal ownership, and our rule is that AI suggests while code and people decide.
- **A third-party KYC or identity service (e.g. Persona, Onfido).**
  - It verifies the *person*, not the land or the community's consent.
  - It adds a vendor that processes ID documents.
  - It's paid beyond free tiers.

  Out of scope; it could be added later as one more check row.
- **No verification for the hackathon.** Rejected: judges will ask "how do you know it's their land?", and an honest, visible answer is stronger than none.
