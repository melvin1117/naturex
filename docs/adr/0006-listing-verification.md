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
| `revoked` | An approved listing was later found wrong (dispute, new evidence) | Admin revokes with reasons |

- Rating and browsing work at any level.
- **In the live world, launching an IPO requires `verified`.** Sandbox worlds start the curated sites as `verified` by a seeded demo reviewer and also include one unverified listing, so judges can see both.

### 2. Evidence and automated checks: every result is shown
The steward uploads up to 3 documents, for example:
- a land title or agrarian certificate;
- the community assembly's minutes approving the listing;
- the cooperative or ejido registration.

Each run produces a **checklist**, stored with the result and shown to the reviewer and steward. Each item has a pass, warn or fail, the value it found and where it came from.

| Check | How | Type |
|---|---|---|
| File is what it claims | MIME allowlist (PDF, JPEG, PNG), ≤ 5 MB each, magic-byte sniff, SHA-256 recorded | Deterministic |
| Not reused | The same document hash isn't attached to another listing in this world | Deterministic |
| Boundary is free | No overlap with another listing in this world (T36/T58) | Deterministic |
| Document readable | MiniCPM-V extracts the fields: holder name, parcel ID, place, area, issue date. Each field is schema-validated and keeps its raw text | AI (perception) |
| Document matches the listing | Nemotron compares the extracted fields with the listing: community name, municipality or state (Nominatim reverse geocode of the centroid), and area within ±20%. Each comparison is listed with both values | AI (judgement), plus a deterministic area and place comparison |
| Consent present | A document of type "assembly minutes / consent" is attached | Deterministic |
| Not checked (shown explicitly) | Registry lookup, legal validity, signatures, whether the uploader is who they say | Disclosure |

- **The AI only suggests.** It can't set `verified`. It returns `consistent`, `inconsistent` or `unreadable`, with reasons that cite the extracted fields. This follows AGENTS.md: the LLM classifies and explains, and deterministic code and humans decide.
- **Document text is untrusted input.** It is quoted to the model as data, never as instructions, the same way News Scout handles articles (T24). Model output is schema-validated.

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
  - the SHA-256 of each document.

  It never contains the documents or personal names. Anyone can later check that a document shown to them matches the hash recorded at verification time, without the ledger exposing the document.

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

### 5. Privacy and file safety
- **Documents** are stored privately (object storage, not public). Only the community's members and reviewers can read them.
- **Deletion:** they are deleted when the listing is deleted or the account is deleted (K5); the ledger keeps only hashes.
- **Uploads:** the allowlist, size cap and magic-byte check above; files are stored under a generated name; nothing from a document is rendered as HTML.
- **Extracted personal fields** (holder name) are shown only to members and reviewers. The public panel shows only pass/warn/fail.

### 6. The real-world path (not built in the hackathon)
The same data model and checklist extend to real verification by adding check rows and reviewer roles, not by replacing the design:
1. **Registry lookup.**
   - Mexico: the Registro Agrario Nacional (RAN) for ejido and communal land; the state public property registry and cadastre for private land. Other countries have their own registries.
   - A partner with registry access confirms the parcel and the holder, giving a new check row "Registry match".
2. **Legal entity.** Confirm the community's cooperative or ejido registration and the authority of the person listing.
3. **Free, prior and informed consent (FPIC).** Assembly minutes with quorum, held in the community's language, are checked by the partner. This is the standard for indigenous and communal land.
4. **Accredited third-party verifiers.** Local NGOs or validation bodies, similar to how carbon-credit projects are validated, act as `partner_reviewer`. Each has a public profile, and their decisions are ledgered like the admin's.
5. **Public notice and objection period.** A listing is announced, for example 30 days before the IPO. Anyone can file an objection, and the reviewer must resolve it.
6. **Re-verification and disputes.** Re-verify yearly, and on any boundary change or valid dispute; `revoked` pauses trading.
7. **Optional anchoring.** Anchor the verification ledger entry's hash publicly (OpenTimestamps, F3) for extra assurance.

## Consequences
- **New tasks:**
  - **T69 (backend):** evidence upload, checklist, AI consistency check, reviewer decision, ledger entry, IPO gate in the live world.
  - **T70 (UI):** steward upload and status, the Exchange "How this listing was verified" panel and badge, the admin review queue.
- **Schema:** a `listing_verifications` table and a private `listing_documents` table (dev-spec §5). The ledger gains a `verification` kind; this needs a migration to the ledger's `kind` check constraint.
- **T59 (IPO launch):** in the live world, T69 adds the "must be verified" rule.
- **T46 (E2E):** the real-account path includes upload → admin approves → IPO.
- **Reused work:** the AI check reuses the MiniCPM-V perception path from ADR-0003. It doesn't depend on T40 photo evidence; it shares the same model routing.

## Alternatives considered
- **An admin approve button only, with no checks or record.** Rejected as a black box: nobody can see why a listing was trusted.
- **Let the AI decide verification.** Rejected: an LLM reading a scanned PDF can't establish legal ownership, and our rule is that AI suggests while code and people decide.
- **A third-party KYC or identity service (e.g. Persona, Onfido).**
  - It verifies the *person*, not the land or the community's consent.
  - It adds a vendor that processes ID documents.
  - It's paid beyond free tiers.

  Out of scope; it could be added later as one more check row.
- **No verification for the hackathon.** Rejected: judges will ask "how do you know it's their land?", and an honest, visible answer is stronger than none.
