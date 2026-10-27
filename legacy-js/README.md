## Shared Supabase + Streamlit version

The original JavaScript app remains available below as a local browser demo. To run the Python app with the existing Supabase project, use `app.py`; its Supabase email/password login and account creation flow are preserved from the working Campus FindIt Streamlit project. The app stores reports and private claims in Supabase so signed-in students can share them across devices.

From this folder in the VS Code terminal:

~~~powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
streamlit run app.py
~~~

The local `.streamlit/secrets.toml` has already been created for this laptop. It is ignored by Git; do not add it to a commit. For Streamlit Community Cloud, configure the same two settings in the app's Secrets panel. The database schema used by the Python app is in `supabase/schema.sql`.

---
# Campus FindIt

A local-first campus lost-and-found prototype built with browser-native JavaScript, ES modules, and IndexedDB. The campus map is illustrative, not an official map.

## Run and verify

Requires Node.js 18 or newer. No package installation is needed.

~~~powershell
npm run dev
npm test
npm run build
~~~

The dev server uses port 4173 by default. Open <http://localhost:4173>. Set the PORT environment variable to an available port if that port is already occupied. The static build is written to dist/.

## Phase 1 workflows

- Lost and found reports require category, item type, date, public description, and an exact campus landmark. Exact landmark, added location detail, and ownership clues are kept in the local record and shown only to the report owner or demo staff.
- Found reports start as under review. The demo staff role must approve one before public search, matching, or map views can discover it. Approval changes the report to active.
- Optional images accept JPEG, PNG, or WebP up to 3 MiB. Selection shows a preview; file type, size, reading, and decoding are checked again at submission. The image data URL is stored in the report in IndexedDB.
- Public report projection is centralized in src/domain.js. It replaces exact landmarks with West, Central, or East campus zones. Valuable and identity-bearing items publish only generic details; their image, precise area, unique type, and color remain restricted.
- The map supports report markers, the campus explorer, location views, and lost, found, or combined hotspots. Hotspots use broad zones and require at least three qualifying unique reports in the selected seven-day or 30-day window. These aggregates describe report frequency only and are not safety or crime findings.
- A claimant can submit one active claim for an approved found report, provide private explanation and evidence, and use a local conversation associated with that claim and report. Staff can request more information, approve for an in-person check, reject, or route a claim for human review.
- A staff-approved claim can enter official custody. Staff must save all three checklist items before completing handover. The report, claim, custody record, audit event, and participant notices are written in one IndexedDB transaction. Completed handovers are read-only.
- My Activity, notifications, admin review, and Insights use the relevant local role or centralized public projection. Local demo role switching moves between Demo claimant, Demo finder, and Demo staff.

Claim statuses reuse the existing values: Submitted, Under review, More information required, Disputed, Approved for in-person verification, Handover pending, Rejected, and Recovered.

The normal transitions are:

~~~text
Submitted -> Under review | More information required | Approved for in-person verification | Disputed | Rejected
Under review -> More information required | Approved for in-person verification | Disputed | Rejected
More information required -> Under review | Approved for in-person verification | Disputed | Rejected
Disputed -> Under review | Rejected
Approved for in-person verification -> Handover pending | Disputed | Rejected
Handover pending -> Recovered (only after active custody and all three checks)
Rejected / Recovered -> terminal
~~~

## Storage and security limits

The app uses IndexedDB database campus-findit. Schema version 2 adds the messages object store without deleting prior stores or records. Version 1 JSON exports remain importable; version 2 exports include messages. Report, claim, review, custody, message, and handover bundles use IndexedDB read-write transactions. Browser profile storage is local and persists across refreshes.

This is a single-browser prototype. Messages do not travel to another device or browser profile. The three demo identities and client-side access checks are for workflow demonstration only; they are not secure authentication or authorization. A person with access to the browser profile can inspect or alter local records. There is no trusted server, cross-device synchronization, secure end-to-end chat, identity verification, photo moderation, or conflict resolution service. Do not store credentials, payment details, access codes, or unredacted identity documents. A real campus deployment needs a trusted backend and formal privacy/security review.

No reports or accounts are seeded. The repository uses in-memory fallback only when IndexedDB is absent, such as the Node unit-test process; this fallback is not a persistence guarantee.

## Checks

npm test runs the existing Node test suite plus workflow, projection, hotspot, image-validation, atomic-write, message-safety, and repository tests. It does not by itself prove browser IndexedDB behavior. npm run build creates a static copy of index.html, styles.css, and src/ in dist/.

## Deploy to Vercel

This is a static vanilla JavaScript application. The Vercel configuration builds the existing static site with npm run build and serves dist/. In the Vercel project settings, use Framework Preset Other, Build Command npm run build, and Output Directory dist. No environment variables or backend services are required.

The application uses hash navigation such as /#find. Browsers request the root document on refresh because URL fragments are not sent to the server, so no path rewrite is needed. The campus diagram is inline SVG rendered by the map view; it has no separate image asset to copy. The build includes index.html, styles.css, and all source modules.

Deploying the files does not make application records shared. Reports, uploaded image data, claims, and messages use IndexedDB in the current browser profile. Each visitor has separate local data; there is no multi-user synchronization, shared chat, hosted database, or server-side authorization.


### Advanced Supabase features

To turn on the Campus map, report hotspots, privacy-filtered listings, and staff handovers in the Python app, run `supabase/advanced_features.sql` in the same Supabase project after the base schema. Then add a confirmed campus staff account to `campus_staff` as shown in README_STREAMLIT.md. Student login and registration remain unchanged.
