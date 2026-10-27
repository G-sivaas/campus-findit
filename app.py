from __future__ import annotations

import html
import uuid
from datetime import date as date_type
from urllib.parse import urlparse

import streamlit as st
from supabase import Client, create_client
from ui.advanced import campus_map_page, insights_page, is_sensitive_item, staff_handover_page

CATEGORIES = [
    "ID cards", "Books & notebooks", "Bags", "Wallets", "Earphones",
    "Electronic devices", "Keys", "Watches & accessories", "Water bottles",
    "Stationery", "Clothing", "Other",
]
STATUSES = {"Lost": "lost", "Found": "found"}
PHOTO_BUCKET = "campus-item-photos"
MAX_PHOTO_BYTES = 3 * 1024 * 1024
PUBLIC_FIELDS = (
    "id,owner_id,item_name,item_type,category,status,location,description,"
    "brand,color,report_date,approximate_time,image_url,photo_path,resolved,"
    "created_at,approved,review_status"
)
LOCATIONS = [
    ("gate-main", "Main Entrance Gate", "West campus"),
    ("gate-east", "East Gate", "East campus"),
    ("security", "Security Checkpoint", "West campus"),
    ("cse", "CSE Block", "West campus"),
    ("ece", "ECE Block", "Central campus"),
    ("eee", "EEE Block", "East campus"),
    ("science", "Science Block", "West campus"),
    ("lab", "Computer Laboratory", "Central campus"),
    ("physics", "Physics Laboratory", "East campus"),
    ("library", "Central Library", "Central campus"),
    ("reading", "Reading Room", "Central campus"),
    ("canteen", "Canteen", "East campus"),
    ("admin", "Administrative Office", "West campus"),
    ("auditorium", "Auditorium", "Central campus"),
    ("playground", "Playground", "East campus"),
    ("garden", "Central Garden", "Central campus"),
    ("bike", "Bike Parking", "West campus"),
    ("bus", "Bus Pickup Area", "East campus"),
    ("water", "Water Point", "Central campus"),
]


def get_client() -> Client:
    if "supabase_client" not in st.session_state:
        try:
            url = st.secrets["SUPABASE_URL"]
            key = st.secrets["SUPABASE_KEY"]
        except Exception as exc:
            raise RuntimeError(
                "Supabase is not configured. Add SUPABASE_URL and SUPABASE_KEY "
                "to .streamlit/secrets.toml, then restart the app."
            ) from exc
        st.session_state.supabase_client = create_client(url, key)
    return st.session_state.supabase_client


def db_call(action, fallback: str):
    """Run a Supabase operation and show a safe, human-readable error."""
    try:
        return action()
    except Exception:
        st.error(fallback)
        return None


def signed_in_user():
    return st.session_state.get("user")


def valid_image_url(value: str) -> bool:
    if not value:
        return True
    parsed = urlparse(value)
    return parsed.scheme == "https" and bool(parsed.netloc)


def sign_out() -> None:
    try:
        get_client().auth.sign_out()
    except Exception:
        pass
    st.session_state.pop("user", None)
    st.rerun()


def auth_page() -> None:
    st.markdown("## Welcome to Campus FindIt")
    st.write("Sign in or create an account to help campus belongings find their way home.")
    login_tab, signup_tab = st.tabs(["Log in", "Create account"])

    with login_tab:
        with st.form("login_form"):
            email = st.text_input("University email", key="login_email")
            password = st.text_input("Password", type="password", key="login_password")
            submitted = st.form_submit_button("Log in", type="primary", use_container_width=True)
        if submitted:
            if not email.strip() or not password:
                st.warning("Enter your email and password.")
            else:
                try:
                    response = get_client().auth.sign_in_with_password(
                        {"email": email.strip(), "password": password}
                    )
                    if response.user:
                        st.session_state.user = {
                            "id": str(response.user.id),
                            "email": response.user.email or email.strip(),
                        }
                        st.rerun()
                    st.error("We couldn’t sign you in. Check your details and try again.")
                except Exception:
                    st.error("We couldn’t sign you in. Check your details or confirm your email.")

    with signup_tab:
        with st.form("signup_form"):
            new_email = st.text_input("University email", key="signup_email")
            new_password = st.text_input("Create password (at least 8 characters)", type="password")
            confirm_password = st.text_input("Confirm password", type="password")
            submitted = st.form_submit_button("Create account", type="primary", use_container_width=True)
        if submitted:
            if not new_email.strip() or len(new_password) < 8:
                st.warning("Enter your email and a password with at least 8 characters.")
            elif new_password != confirm_password:
                st.warning("Those passwords don’t match yet.")
            else:
                try:
                    response = get_client().auth.sign_up(
                        {"email": new_email.strip(), "password": new_password}
                    )
                    if response.session and response.user:
                        st.session_state.user = {
                            "id": str(response.user.id),
                            "email": response.user.email or new_email.strip(),
                        }
                        st.success("Your account is ready.")
                        st.rerun()
                    st.success("Check your university inbox to confirm your account, then log in here.")
                except Exception:
                    st.error("We couldn’t create the account. Check the email and try again.")


def fetch_items(mine: bool = False) -> list[dict] | None:
    try:
        get_client()
    except RuntimeError as exc:
        st.error(str(exc))
        st.stop()

    user = signed_in_user()
    def operation():
        table_name = "campus_items" if mine else "campus_items_public"
        fields = PUBLIC_FIELDS if mine else f"{PUBLIC_FIELDS},zone_name"
        query = get_client().table(table_name).select(fields)
        if mine:
            query = query.eq("owner_id", user["id"])
        else:
            query = query.eq("resolved", False)
        return query.order("created_at", desc=True).limit(200).execute().data or []
    result = db_call(operation, "Items couldn’t be loaded right now. Please try again.")
    return result


def _match_score(lost_item: dict, found_item: dict) -> int:
    score = 0
    for field, points in (("category", 28), ("item_type", 24), ("brand", 15), ("color", 12)):
        left = str(lost_item.get(field) or "").strip().casefold()
        right = str(found_item.get(field) or "").strip().casefold()
        if left and right and left != "restricted item" and right != "restricted item":
            if left == right:
                score += points
            elif field in {"item_type", "brand"} and (left in right or right in left):
                score += points // 2
    if lost_item.get("zone_name") and lost_item.get("zone_name") == found_item.get("zone_name"):
        score += 8
    left_date = lost_item.get("report_date")
    right_date = found_item.get("report_date")
    if left_date and right_date:
        try:
            days = abs((date_type.fromisoformat(str(left_date)[:10]) - date_type.fromisoformat(str(right_date)[:10])).days)
            score += 9 if days <= 1 else 5 if days <= 7 else 0
        except ValueError:
            pass
    return min(score, 100)


def dashboard(items: list[dict]) -> None:
    open_items = [item for item in items if not item.get("resolved")]
    lost = sum(item.get("status") == "lost" for item in open_items)
    found = sum(item.get("status") == "found" for item in open_items)
    total = st.columns(3)
    total[0].metric("Total reports", len(open_items))
    total[1].metric("Lost", lost)
    total[2].metric("Found", found)

    user_id = (signed_in_user() or {}).get("id")
    my_lost = [item for item in open_items if item.get("owner_id") == user_id and item.get("status") == "lost"]
    found_items = [item for item in open_items if item.get("status") == "found" and item.get("owner_id") != user_id]
    suggestions = []
    for lost_item in my_lost:
        for found_item in found_items:
            score = _match_score(lost_item, found_item)
            if score >= 35:
                suggestions.append((score, lost_item, found_item))
    if suggestions:
        st.markdown("### Possible leads for your lost items")
        st.caption("These are suggestions based on shared details. Check ownership privately before arranging a return.")
        for score, lost_item, found_item in sorted(suggestions, key=lambda row: row[0], reverse=True)[:3]:
            found_name = html.escape(str(found_item.get("item_type") or found_item.get("item_name") or "Found item"))
            lost_name = html.escape(str(lost_item.get("item_type") or lost_item.get("item_name") or "your report"))
            st.info(f"{score}% possible match · {found_name} may match {lost_name}. Open Browse & search to send a private claim.")

    st.markdown(
        """
        <section class="how-card">
          <div class="eyebrow">A small campus kindness</div>
          <h3>Three steps to a happy reunion</h3>
          <div class="how-grid">
            <div><b>01 · Share</b><span>Post useful details and keep one ownership clue private.</span></div>
            <div><b>02 · Search</b><span>Browse reports by item type, category, and broad campus area.</span></div>
            <div><b>03 · Reconnect</b><span>Send a private claim and arrange a safe handoff.</span></div>
          </div>
        </section>
        """,
        unsafe_allow_html=True,
    )


def signed_photo_url(item: dict) -> str | None:
    path = item.get("photo_path")
    if path:
        try:
            result = get_client().storage.from_(PHOTO_BUCKET).create_signed_url(str(path), 900)
            return result.get("signedURL") or result.get("signedUrl")
        except Exception:
            return None
    legacy_url = str(item.get("image_url") or "")
    return legacy_url if valid_image_url(legacy_url) else None


def item_card(item: dict) -> None:
    status = str(item.get("status", "lost")).lower()
    badge = "LOST" if status == "lost" else "FOUND"
    class_name = "lost" if status == "lost" else "found"
    user = signed_in_user() or {}
    is_owner = item.get("owner_id") == user.get("id")
    restricted = is_sensitive_item(item) and not is_owner
    name_text = "Restricted item" if restricted else str(item.get("item_type") or item.get("item_name", "Item"))
    name = html.escape(name_text)
    category = html.escape("Restricted item" if restricted else str(item.get("category", "Other")))
    location = html.escape(str(item.get("zone_name") or item.get("location") or "Campus"))
    description = html.escape(
        "A restricted item has been reported. Send a private claim to verify ownership."
        if restricted else str(item.get("description", ""))
    )
    photo_url = None if restricted else signed_photo_url(item)
    if photo_url:
        st.image(photo_url, use_container_width=True, caption="Item photo")
    details = []
    if not restricted and item.get("brand"):
        details.append(f"Brand: {html.escape(str(item['brand']))}")
    if not restricted and item.get("color"):
        details.append(f"Colour: {html.escape(str(item['color']))}")
    details_html = f'<div class="muted">{" · ".join(details)}</div>' if details else ""
    st.markdown(
        f"""
        <article class="item-card">
          <div class="item-card-body">
            <span class="badge {class_name}">{badge}</span>
            <span class="muted">{category}</span>
            <h3>{name}</h3>
            {details_html}
            <p>{description}</p>
            <div class="muted">📍 {location} · {html.escape(str(item.get('report_date') or ''))}</div>
          </div>
        </article>
        """,
        unsafe_allow_html=True,
    )
    if not is_owner and not item.get("resolved") and status == "found":
        if st.button("I think this may be mine", key=f"claim-{item['id']}"):
            st.session_state.selected_item = item["id"]
    if st.session_state.get("selected_item") == item.get("id"):
        with st.form(f"claim-form-{item['id']}"):
            proof = st.text_area(
                "A detail that helps confirm it belongs to you",
                max_chars=250,
                help="Keep this private. Don’t share passwords, full ID numbers, or financial details.",
            )
            message = st.text_area("Message for the person who posted it", max_chars=500)
            submit = st.form_submit_button("Send private claim")
        if submit:
            if len(proof.strip()) < 3:
                st.warning("Add one useful identifying detail.")
            else:
                result = db_call(
                    lambda: get_client().table("campus_claims").insert({
                        "item_id": item["id"],
                        "claimant_id": user["id"],
                        "ownership_proof": proof.strip(),
                        "message": message.strip(),
                    }).execute(),
                    "We couldn’t send this claim. You may already have a request for this item.",
                )
                if result is not None:
                    st.session_state.pop("selected_item", None)
                    st.success("Your private claim was sent to the person who posted this item.")
                    st.rerun()


def report_form() -> None:
    st.markdown("#### About the item")
    kind_label = st.radio(
        "What happened?", ["I lost something", "I found something"],
        horizontal=True, key="report_kind",
    )
    status = "lost" if kind_label == "I lost something" else "found"
    photo = st.file_uploader(
        "Add a photo (optional)",
        type=["jpg", "jpeg", "png", "webp"],
        help="JPEG, PNG, or WebP up to 3 MiB. Avoid photos showing full ID numbers or faces.",
        key=f"report_photo_upload_{st.session_state.get('report_photo_version', 0)}",
    )
    if photo is not None:
        st.image(photo, caption="Photo preview", width=320)

    with st.form("report_form", clear_on_submit=True):
        category = st.selectbox("Category *", CATEGORIES)
        item_type = st.text_input("Item type *", max_chars=80, placeholder="e.g. Blue notebook")
        left, right = st.columns(2)
        brand = left.text_input("Brand or model (optional)", max_chars=80, placeholder="If known")
        color = right.text_input("Colour (optional)", max_chars=40, placeholder="e.g. Navy blue")
        date_value = left.date_input(
            "Date last seen / found *", value=date_type.today(), max_value=date_type.today()
        )
        time_value = right.time_input("Approximate time (optional)", value=None)
        description = st.text_area(
            "Public description *", max_chars=300,
            placeholder="Describe visible details without giving away your private clue.",
        )
        value_classification = "Less expensive"
        handling = "With me for now"
        if status == "found":
            value_classification = st.selectbox(
                "Value classification", ["Less expensive", "Expensive"]
            )
            handling = st.selectbox(
                "How is it being handled?",
                ["With me for now", "Handed to campus staff", "At the security desk"],
            )
            st.caption("Found reports are reviewed by approved campus staff before public listing.")
        private_clue = st.text_area(
            "Private distinguishing detail (optional)", max_chars=300,
            placeholder="A mark, sticker, engraving, or detail only the owner knows.",
            help="Only you and authorized campus staff can see this detail.",
        )
        location_names = [entry[1] for entry in LOCATIONS]
        location_choice = st.selectbox(
            "Exact campus landmark * (kept private)",
            ["Choose a campus landmark"] + location_names,
        )
        location_detail = st.text_input(
            "Additional location detail (optional, kept private)", max_chars=120,
            placeholder="e.g. Near the second-floor reading tables",
        )
        contact = st.text_input(
            "Private contact information *", max_chars=160,
            help="Only you can see this. Students contact you through private claims.",
        )
        st.caption("Keep one ownership clue private. Don’t upload full IDs, payment cards, addresses, or faces.")
        submit = st.form_submit_button(f"Submit {status} report", type="primary")

    if not submit:
        return
    if len(item_type.strip()) < 2 or len(description.strip()) < 3 or len(contact.strip()) < 3:
        st.warning("Please enter an item type, a clear description, and private contact details.")
        return
    if location_choice == "Choose a campus landmark":
        st.warning("Choose the campus landmark where the item was lost or found.")
        return
    if date_value > date_type.today():
        st.warning("The report date cannot be in the future.")
        return
    if photo is not None:
        if photo.type not in {"image/jpeg", "image/png", "image/webp"}:
            st.warning("Choose a JPEG, PNG, or WebP image.")
            return
        if photo.size <= 0 or photo.size > MAX_PHOTO_BYTES:
            st.warning("Photos must be between 1 byte and 3 MiB.")
            return
    location_id, location_name, _zone_name = next(
        entry for entry in LOCATIONS if entry[1] == location_choice
    )
    item_id = str(uuid.uuid4())
    owner_id = signed_in_user()["id"]
    photo_path = None
    if photo is not None:
        extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[photo.type]
        photo_path = f"{owner_id}/{item_id}/photo{extension}"
    item_payload = {
        "id": item_id,
        "owner_id": owner_id,
        "item_name": item_type.strip(),
        "item_type": item_type.strip(),
        "category": category,
        "status": status,
        "location": location_name,
        "location_id": location_id,
        "description": description.strip(),
        "brand": brand.strip() or None,
        "color": color.strip() or None,
        "report_date": date_value.isoformat(),
        "approximate_time": time_value.isoformat() if time_value else None,
        "value_classification": value_classification,
        "handling": handling,
        "photo_path": photo_path,
    }
    client = get_client()
    try:
        client.table("campus_items").insert(item_payload).execute()
        if photo is not None and photo_path:
            client.storage.from_(PHOTO_BUCKET).upload(
                photo_path, photo.getvalue(), {"content-type": photo.type}
            )
        client.table("campus_item_private").insert({
            "item_id": item_id,
            "owner_id": owner_id,
            "contact_info": contact.strip(),
            "private_clue": private_clue.strip() or None,
            "location_detail": location_detail.strip() or None,
        }).execute()
        st.success(
            "Your lost report is live. Thanks for helping the campus community."
            if status == "lost" else
            "Your found report is saved and waiting for a campus staff review."
        )
        st.session_state.report_photo_version = st.session_state.get("report_photo_version", 0) + 1
        st.rerun()
    except Exception:
        try:
            if photo_path:
                client.storage.from_(PHOTO_BUCKET).remove([photo_path])
        except Exception:
            pass
        try:
            client.table("campus_items").delete().eq("id", item_id).eq("owner_id", owner_id).execute()
        except Exception:
            pass
        st.error(
            "We couldn’t publish this report. Check that the new Campus FindIt fields and private photo bucket are set up in Supabase, then try again."
        )


def my_reports(items: list[dict]) -> None:
    mine = fetch_items(mine=True)
    if mine is None:
        return
    if not mine:
        st.info("Your reports will appear here after you post one.")
        return
    for item in mine:
        with st.container(border=True):
            left, right = st.columns([5, 1])
            left.markdown(f"**{html.escape(str(item.get('item_type') or item['item_name']))}** · {item['status'].replace('_', ' ').title()}")
            left.caption(f"{item['category']} · {item['location']} · {item.get('report_date') or ''}")
            if item.get("review_status") == "pending":
                left.info("Your found report is waiting for staff review.")
            if item.get("resolved"):
                left.success("Resolved")
            else:
                if right.button("Mark resolved", key=f"resolve-{item['id']}"):
                    result = db_call(
                        lambda: get_client().table("campus_items").update({"resolved": True})
                            .eq("id", item["id"]).eq("owner_id", signed_in_user()["id"]).execute(),
                        "This report couldn’t be updated. Please try again.",
                    )
                    if result is not None:
                        st.success("Marked as resolved. Thanks for closing the loop!")
                        st.rerun()
                if right.button("Delete", key=f"delete-{item['id']}"):
                    try:
                        photo_path = item.get("photo_path")
                        if photo_path:
                            get_client().storage.from_(PHOTO_BUCKET).remove([str(photo_path)])
                        get_client().table("campus_items").delete().eq("id", item["id"]).eq(
                            "owner_id", signed_in_user()["id"]
                        ).execute()
                        st.success("Your report and its photo were deleted.")
                        st.rerun()
                    except Exception:
                        st.error("This report couldn’t be deleted right now. Please try again.")
            with st.expander("Your private report details"):
                private = db_call(
                    lambda: get_client().table("campus_item_private")
                        .select("contact_info,private_clue,location_detail")
                        .eq("item_id", item["id"]).single().execute().data,
                    "Private report details couldn’t be loaded.",
                )
                if private:
                    st.write("**Contact:**", private.get("contact_info") or "Not provided")
                    st.write("**Private ownership clue:**", private.get("private_clue") or "None saved")
                    st.write("**Extra location detail:**", private.get("location_detail") or "None saved")
                    st.write("**Handling:**", item.get("handling") or "Not provided")


def claims_page() -> None:
    st.subheader("Claim requests")
    sent, received = st.tabs(["Claims I sent", "Claims on my reports"])
    with sent:
        data = db_call(
            lambda: get_client().table("campus_claims")
                .select("id,item_id,ownership_proof,message,status,owner_response,created_at")
                .eq("claimant_id", signed_in_user()["id"]).order("created_at", desc=True).execute().data or [],
            "Your claims couldn’t be loaded.",
        ) or []
        names = _item_names([claim["item_id"] for claim in data])
        if not data:
            st.info("Claims you send will appear here with their private replies.")
        for claim in data:
            with st.container(border=True):
                st.markdown(f"**{html.escape(names.get(claim['item_id'], 'Restricted item'))}** · {claim['status'].replace('_', ' ').title()}")
                if claim.get("owner_response"):
                    st.write(claim["owner_response"])
    with received:
        mine = fetch_items(mine=True) or []
        ids = [item["id"] for item in mine]
        data = []
        if ids:
            data = db_call(
                lambda: get_client().table("campus_claims")
                    .select("id,item_id,ownership_proof,message,status,owner_response,created_at")
                    .in_("item_id", ids).order("created_at", desc=True).execute().data or [],
                "Claim requests couldn’t be loaded.",
            ) or []
        names = {item["id"]: item["item_name"] for item in mine}
        if not data:
            st.info("No claim requests for your reports yet.")
        for claim in data:
            with st.container(border=True):
                st.markdown(f"**{html.escape(names.get(claim['item_id'], 'Item'))}** · {claim['status'].replace('_', ' ').title()}")
                st.markdown("**Private ownership detail:**")
                st.write(claim["ownership_proof"])
                if claim.get("message"):
                    st.write(claim["message"])
                if claim["status"] == "pending":
                    with st.form(f"review-{claim['id']}"):
                        reply = st.text_input("Private reply / handoff plan", max_chars=500)
                        approve, decline = st.columns(2)
                        yes = approve.form_submit_button("Approve and reply", type="primary")
                        no = decline.form_submit_button("Decline")
                    if yes or no:
                        result = db_call(
                            lambda: get_client().table("campus_claims").update({
                                "status": "approved" if yes else "declined",
                                "owner_response": reply.strip(),
                            }).eq("id", claim["id"]).execute(),
                            "We couldn’t update the claim. Please try again.",
                        )
                        if result is not None:
                            st.success("Your private response was sent.")
                            st.rerun()


def _item_names(item_ids: list[str]) -> dict[str, str]:
    if not item_ids:
        return {}
    rows = db_call(
        lambda: get_client().table("campus_items_public").select("id,item_name").in_("id", item_ids).execute().data or [],
        "Related item names couldn’t be loaded.",
    ) or []
    return {row["id"]: row["item_name"] for row in rows}


def main() -> None:
    st.set_page_config(page_title="Campus FindIt", page_icon="🔎", layout="wide")
    st.markdown(
        """
        <style>
        .block-container{max-width:1180px;padding-top:2rem}
        .hero{padding:1.8rem;border-radius:22px;background:linear-gradient(120deg,#e7f1ec,#f6f7f4);margin-bottom:1.2rem}
        .hero h1{font-size:2.5rem;letter-spacing:-.05em;margin:.3rem 0;color:#14213d}
        .hero p{color:#506078;margin:0;font-size:1.05rem}
        .eyebrow{color:#246B59;text-transform:uppercase;letter-spacing:.12em;font-size:.75rem;font-weight:700}
        .how-card{background:#f8faff;border:1px solid #e5ecfa;border-radius:18px;padding:1.2rem;margin:1rem 0}
        .how-card h3{margin:.3rem 0 1rem}
        .how-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1rem}
        .how-grid div{display:flex;flex-direction:column;gap:.4rem}
        .how-grid span,.muted{color:#667085;font-size:.9rem}
        .item-card{overflow:hidden;border:1px solid #e5e7eb;border-radius:18px;background:white;margin:0 0 .5rem}
        .item-card img{width:100%;height:190px;object-fit:cover;background:#f1f5f9}
        .item-card-body{padding:1rem}
        .item-card h3{margin:.55rem 0}
        .item-card p{color:#475467;min-height:2rem}
        .badge{font-size:.7rem;font-weight:800;letter-spacing:.08em;padding:.28rem .55rem;border-radius:999px;margin-right:.5rem}
        .badge.lost{color:#b42318;background:#fef3f2}
        .badge.found{color:#067647;background:#ecfdf3}
        .campus-map{background:#f6f8f6;border:1px solid #e6e9e4;border-radius:18px;padding:1.3rem;margin:1rem 0}
        .campus-map-label{font-size:.72rem;letter-spacing:.13em;font-weight:800;color:#76817c;margin-bottom:1rem}
        .zone-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:.8rem}
        .zone-tile{min-height:112px;border:1px solid #e6e9e4;border-radius:14px;background:#fff;padding:1rem;display:flex;flex-direction:column;gap:.3rem}
        .zone-tile span{font-size:.86rem;color:#475467}.zone-tile strong{font-size:1.8rem;color:#246B59}.zone-tile small{color:#76817c}
        .campus-map-foot{margin-top:1rem;color:#667085;font-size:.84rem}
        .zone-bar-row{display:grid;grid-template-columns:150px 1fr 32px;align-items:center;gap:.7rem;margin:.6rem 0;font-size:.88rem}
        .zone-bar-track{height:12px;background:#edf1ee;border-radius:99px;overflow:hidden}.zone-bar-fill{height:100%;background:#246B59;border-radius:99px}
        .stButton>button{border-radius:10px;font-weight:650}
        [data-testid="stFileUploaderDropzone"]{border:1px dashed #9db9ac;border-radius:14px;background:#fbfdfb}
        [data-testid="stForm"]{border:1px solid #e3eae5;border-radius:18px;padding:1rem;background:#fff}
        [data-testid="stMetric"]{background:#fff;border:1px solid #e5ece7;border-radius:16px;padding:1rem}
        @media(max-width:700px){.how-grid{grid-template-columns:1fr}.zone-grid{grid-template-columns:repeat(2,1fr)}.zone-bar-row{grid-template-columns:100px 1fr 28px}.hero h1{font-size:2rem}}
        </style>
        """,
        unsafe_allow_html=True,
    )
    st.markdown(
        '<section class="hero"><div class="eyebrow">Campus FindIt · Lost & Found</div>'
        '<h1>Good things find their way back.</h1>'
        '<p>A friendly campus space to report, search, and reunite lost belongings.</p></section>',
        unsafe_allow_html=True,
    )

    try:
        get_client()
    except RuntimeError as exc:
        st.error(str(exc))
        st.stop()

    user = signed_in_user()
    if user is None:
        auth_page()
        return

    header, signout = st.columns([5, 1])
    header.caption(f"Signed in as {user.get('email', 'campus member')}")
    if signout.button("Log out", use_container_width=True):
        sign_out()

    items = fetch_items()
    if items is None:
        st.info("Check your Supabase secrets and run the Campus FindIt SQL scripts in order, including report_fields_storage.sql.")
        return

    dashboard(items)
    browse_tab, map_tab, insights_tab, report_tab, mine_tab, claims_tab, staff_tab = st.tabs(
        ["Browse & search", "Campus map", "Insights", "Report an item", "My reports", "Claim requests", "Staff handover"]
    )
    with browse_tab:
        filters = st.columns([2, 2, 3])
        status_filter = filters[0].selectbox("Status", ["All", "Lost", "Found"])
        category_filter = filters[1].selectbox("Category", ["All"] + CATEGORIES)
        keyword = filters[2].text_input("Search", placeholder="Item, description, or campus location")
        filtered = items
        if status_filter != "All":
            filtered = [item for item in filtered if item["status"] == STATUSES[status_filter]]
        if category_filter != "All":
            filtered = [item for item in filtered if item["category"] == category_filter]
        if keyword.strip():
            term = keyword.strip().casefold()
            filtered = [item for item in filtered if term in " ".join(
                str(item.get(key, "")) for key in ("item_name", "item_type", "brand", "color", "description", "location", "zone_name", "category")
            ).casefold()]
        if not filtered:
            st.info("No matching reports yet. Try another search or post what you’re looking for.")
        else:
            for start in range(0, len(filtered), 3):
                columns = st.columns(3)
                for col, item in zip(columns, filtered[start:start + 3]):
                    with col:
                        item_card(item)
    with map_tab:
        campus_map_page(items)
    with insights_tab:
        insights_page(items)
    with report_tab:
        st.subheader("Tell the campus what happened")
        st.write("A few clear details can help the right person recognize an item.")
        report_form()
    with mine_tab:
        st.subheader("Your reports")
        my_reports(items)
    with claims_tab:
        claims_page()
    with staff_tab:
        staff_handover_page()

    st.divider()
    st.caption(
        "Keep one ownership detail private. Arrange handoffs at a staffed campus location. "
        "Never post passwords, full ID numbers, or financial details."
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        st.error("Campus FindIt hit a problem loading. Refresh the page or check your Supabase configuration.")



