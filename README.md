# Campus FindIt

A warm, responsive Streamlit conversion of the Campus FindIt mobile reference. Students can create an account, post detailed lost or found reports with private clues and optional photos, search broad campus listings, and exchange private claim messages to arrange a safe return.

## What is included

- app.py — Streamlit interface, Supabase email/password authentication, report creation, browse/search, personal reports, and private claim replies.
- supabase/schema.sql — core tables, authentication checks, grants, and Row Level Security policies.
- supabase/advanced_features.sql — masked public listings, broad campus zones, staff custody, and safe handover.
- supabase/report_fields_storage.sql — reference-page fields, found-report review, and private Supabase photo storage.
- .streamlit/secrets.toml.example — local secrets template. Copy it to .streamlit/secrets.toml and add your own values.
- requirements.txt — Python dependencies.
- .gitignore — excludes credentials and local files.

The report form follows the reference page: lost/found choice, category, item type, brand, colour, date/time, public description, private ownership clue, exact landmark, optional private location detail, contact, and optional photo. Photos are limited to JPEG/PNG/WebP up to 3 MiB and stored in a private Supabase Storage bucket. Contact details, exact landmarks, extra location details, and ownership clues are not shown in public listings. Found reports stay private until staff approval.

## 1. Create and configure Supabase

1. Create a Supabase project.
2. In **Authentication → Providers → Email**, enable email/password sign-in and keep email confirmation enabled.
3. In **SQL Editor**, run these scripts in order: `supabase/schema.sql`, `supabase/advanced_features.sql`, then `supabase/report_fields_storage.sql`.
4. If you already ran the first two scripts for this project, run only `supabase/report_fields_storage.sql` now. It adds fields and secure photo storage without deleting reports.
5. The schema permits any Supabase email-confirmed account by default. For campus-only access, edit the commented condition in is_verified_campus_user() to enforce your university email domain, then rerun the function definition in Supabase.
6. In **Project Settings → API**, copy the Project URL and the publishable/anon key. Never use the service-role key in this app.

## 2. Run locally in VS Code (Windows)

1. Install Python 3.11+ and VS Code.
2. Open the `FindIt-main` folder in VS Code.
3. In the VS Code terminal, create and activate a virtual environment, then install the packages:

~~~powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
~~~

4. Copy .streamlit/secrets.toml.example to .streamlit/secrets.toml. Fill in the two values:

~~~toml
SUPABASE_URL = "https://YOUR_PROJECT_ID.supabase.co"
SUPABASE_KEY = "YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY"
~~~

5. Start the app:

~~~powershell
python -m streamlit run app.py --server.port 8503
~~~

6. Create an account with a confirmed university email. Confirm the message sent by Supabase, then log in.

If PowerShell blocks environment activation, run this in the VS Code terminal and activate again:

~~~powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
~~~

## 3. Push the project to GitHub

Create a new empty GitHub repository. In the VS Code terminal, from this project folder, run:

~~~powershell
git init
git add .
git status
git commit -m "Build Campus FindIt"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/campus-findit.git
git push -u origin main
~~~

Before committing, check git status: .streamlit/secrets.toml should not appear. Do not force-add secrets. GitHub stores the code; GitHub Pages cannot run this Python/Streamlit app.

## 4. Deploy with Streamlit Community Cloud

1. Sign in to Streamlit Community Cloud using GitHub and choose **Create app**.
2. Select your repository, the main branch, and app.py as the entrypoint.
3. In **Advanced settings → Secrets**, paste the same two TOML settings used locally.
4. Deploy the app.
5. Open the deployed URL and check account confirmation, login, posting, search, private claim messages, resolve, and delete using two separate accounts.

The app reads credentials only from st.secrets["SUPABASE_URL"] and st.secrets["SUPABASE_KEY"]. Keep the publishable/anon key in app secrets and let the database policies enforce access. Never put the service-role key in Streamlit, GitHub, or this app.

## Privacy and safety built into the app

- Supabase email/password accounts are kept in st.session_state.user across Streamlit reruns; successful login and logout rerun the app cleanly.
- Database operations show plain-language errors instead of exposing raw exception details.
- RLS requires a confirmed Supabase account and limits changes to the report owner. Found-report approval is staff-only. Claims are visible only to the claimant and item owner, and photo access is checked against the linked report.
- The item owner’s contact information is private. Students use the claim flow to coordinate a handoff.
- Photo URLs must use HTTPS. Remind students not to post full ID numbers, payment card details, passwords, or personal addresses.
- Meet at a staffed campus desk or another public, well-lit place.

## Notes

This is a deployable starter app, but a campus administrator should review the SQL policies, email domain restriction, retention rules, and hosting/privacy requirements before real student use. Supabase email confirmation verifies access to an inbox; it does not prove current student enrollment unless your university controls and restricts that email domain.

## Official setup references

- [Supabase Python sign-up](https://supabase.com/docs/reference/python/auth-signup)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Streamlit Community Cloud deployment](https://docs.streamlit.io/deploy/streamlit-community-cloud/deploy-your-app/deploy)
- [Streamlit secrets management](https://docs.streamlit.io/deploy/streamlit-community-cloud/deploy-your-app/secrets-management)

## Enable the map and staff handover tools

For a fresh Supabase project, run `schema.sql`, `advanced_features.sql`, and `report_fields_storage.sql` in that order. If this is your existing Campus FindIt project and you already applied the first two scripts, run only `report_fields_storage.sql` in SQL Editor. It adds the report attributes shown in the reference page, the staff found-report review queue, and a private photo bucket. It keeps existing reports and does not change the login code.

To enable a staff account, first create and confirm that person's account through the app. In Supabase, open **Authentication → Users**, copy that user's ID, then run this SQL with the real UUID and a display name:

~~~sql
insert into public.campus_staff (user_id, display_name)
values ('PASTE_CONFIRMED_STAFF_USER_ID_HERE', 'Campus support')
on conflict (user_id) do update set display_name = excluded.display_name;
~~~

Only a trusted campus administrator should add staff IDs. The `campus_staff` table is not readable or writable by normal app users.

## Original JavaScript prototype

The original browser-only JavaScript project has been preserved in `legacy-js/`. The main app in this project is now the Python Streamlit application in `app.py`.
