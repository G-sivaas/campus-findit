from __future__ import annotations

from datetime import datetime, timedelta, timezone
import html

import streamlit as st

ZONE_NAMES = ("West campus", "Central campus", "East campus", "Other campus area")
HOTSPOT_THRESHOLD = 3


def is_sensitive_item(item: dict) -> bool:
    category = str(item.get("category") or "").casefold()
    name = str(item.get("item_name") or "").casefold()
    return (
        category in {
            "id card", "id cards", "wallet", "wallets", "electronic devices",
            "electronics", "keys", "watches & accessories", "restricted item",
        }
        or any(term in name for term in (
            "passport", "bank card", "access card", "phone", "iphone",
            "smartphone", "laptop", "tablet", "jewelry", "jewellery",
        ))
    )


def _zone(item: dict) -> str:
    zone = str(item.get("zone_name") or "")
    return zone if zone in ZONE_NAMES else "Other campus area"


def _recent(item: dict, days: int) -> bool:
    value = item.get("created_at")
    if not value:
        return False
    try:
        created = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        return created >= datetime.now(timezone.utc) - timedelta(days=days)
    except (TypeError, ValueError):
        return False


def campus_map_page(items: list[dict]) -> None:
    st.subheader("A simple map of campus reports")
    st.caption(
        "This is an illustrative zone map, not an official campus map. Sensitive reports are grouped into broad areas."
    )
    counts = {zone: 0 for zone in ZONE_NAMES}
    for item in items:
        counts[_zone(item)] += 1
    columns = st.columns(4)
    for column, zone in zip(columns, ZONE_NAMES):
        with column:
            st.metric(zone, counts[zone])
    zone_cards = "".join(
        f'<div class="zone-tile"><span>{html.escape(zone)}</span><strong>{counts[zone]}</strong><small>open report{"s" if counts[zone] != 1 else ""}</small></div>'
        for zone in ZONE_NAMES
    )
    st.markdown(
        f'<section class="campus-map" aria-label="Illustrative campus report map">'
        f'<div class="campus-map-label">CAMPUS FINDIT · REPORT ZONES</div>'
        f'<div class="zone-grid">{zone_cards}</div>'
        f'<div class="campus-map-foot">Meet at a staffed desk or another public campus location.</div></section>',
        unsafe_allow_html=True,
    )
    if not items:
        st.info("No open reports to show on the map yet.")


def insights_page(items: list[dict]) -> None:
    st.subheader("Campus activity and hotspots")
    st.caption(
        "Hotspots describe where reports were submitted. They are not safety or crime indicators."
    )
    period = st.selectbox("Time window", ["Past 7 days", "Past 30 days"], key="insights_period")
    days = 7 if period == "Past 7 days" else 30
    recent = [item for item in items if _recent(item, days)]
    zone_counts = {zone: 0 for zone in ZONE_NAMES}
    status_counts = {"lost": 0, "found": 0}
    category_counts: dict[str, int] = {}
    for item in recent:
        zone_counts[_zone(item)] += 1
        status = str(item.get("status") or "").lower()
        if status in status_counts:
            status_counts[status] += 1
        category = str(item.get("category") or "Other")
        category_counts[category] = category_counts.get(category, 0) + 1
    first, second, third = st.columns(3)
    first.metric("Reports in this window", len(recent))
    second.metric("Lost", status_counts["lost"])
    third.metric("Found", status_counts["found"])

    st.markdown(f"**Report counts by broad zone · {period.lower()}**")
    for zone, count in zone_counts.items():
        ratio = max(5, round(count / max(zone_counts.values(), default=0) * 100)) if count else 0
        st.markdown(
            f'<div class="zone-bar-row"><span>{html.escape(zone)}</span>'
            f'<div class="zone-bar-track"><div class="zone-bar-fill" style="width:{ratio}%"></div></div>'
            f'<b>{count}</b></div>',
            unsafe_allow_html=True,
        )
    hotspots = [(zone, count) for zone, count in zone_counts.items() if count >= HOTSPOT_THRESHOLD]
    if hotspots:
        for zone, count in hotspots:
            st.info(f"{zone} has {count} reports in this period. Consider checking the listings for a possible match.")
    else:
        st.caption(f"No report zone has reached the {HOTSPOT_THRESHOLD}-report hotspot threshold in this period.")
    if category_counts:
        st.markdown("**Categories reported**")
        for category, count in sorted(category_counts.items(), key=lambda pair: (-pair[1], pair[0])):
            st.write(f"{category} · {count}")
    else:
        st.info("New reports will appear here as the campus community uses FindIt.")


def staff_handover_page() -> None:
    st.subheader("Staff recovery and safe handover")
    st.caption("Campus staff can verify an approved claim and record a safe in-person return.")
    try:
        result = st.session_state.supabase_client.rpc("is_campus_staff").execute()
        is_staff = bool(result.data)
    except Exception:
        st.info("Staff tools need the advanced Supabase setup. Ask the project admin to run supabase/advanced_features.sql.")
        return
    if not is_staff:
        st.info("This area is for approved campus staff accounts. Students can track claims in Claim requests.")
        return

    client = st.session_state.supabase_client
    st.markdown("#### Found reports waiting for review")
    try:
        pending_reports = client.table("campus_items").select(
            "id,item_name,item_type,category,description,location,report_date,owner_id"
        ).eq("status", "found").eq("approved", False).eq("resolved", False).order(
            "created_at", desc=False
        ).limit(100).execute().data or []
    except Exception:
        pending_reports = []
        st.error("Found reports couldn’t be loaded. Run the Campus FindIt report-fields migration in Supabase.")
    if not pending_reports:
        st.caption("No found reports are waiting for review.")
    for report in pending_reports:
        with st.container(border=True):
            st.markdown(f"**{html.escape(str(report.get('item_type') or report.get('item_name') or 'Found item'))}** · {html.escape(str(report.get('category') or 'Other'))}")
            st.caption(f"{html.escape(str(report.get('location') or 'Campus landmark'))} · {html.escape(str(report.get('report_date') or ''))}")
            st.write(html.escape(str(report.get("description") or "")))
            approve_col, reject_col = st.columns(2)
            if approve_col.button("Approve for campus search", key=f"approve-report-{report['id']}", type="primary"):
                try:
                    client.rpc("review_campus_found_report", {
                        "p_item_id": report["id"], "p_approved": True
                    }).execute()
                    st.success("The found report is now available in campus search.")
                    st.rerun()
                except Exception:
                    st.error("This report couldn’t be approved. Please try again.")
            if reject_col.button("Reject report", key=f"reject-report-{report['id']}"):
                try:
                    client.rpc("review_campus_found_report", {
                        "p_item_id": report["id"], "p_approved": False
                    }).execute()
                    st.success("The report was declined and will stay private.")
                    st.rerun()
                except Exception:
                    st.error("This report couldn’t be updated. Please try again.")

    try:
        approved_claims = client.table("campus_claims").select(
            "id,item_id,claimant_id,ownership_proof,message,status,owner_response,created_at"
        ).eq("status", "approved").order("created_at", desc=True).limit(100).execute().data or []
        active_custody = client.table("campus_custody").select(
            "id,item_id,claim_id,claimant_id,identity_checked,item_checked,recipient_acknowledged,status,created_at"
        ).eq("status", "in_custody").order("created_at", desc=True).limit(100).execute().data or []
        item_ids = sorted({row["item_id"] for row in approved_claims + active_custody})
        item_rows = client.table("campus_items").select("id,item_name,category,location,owner_id").in_("id", item_ids).execute().data if item_ids else []
        items_by_id = {row["id"]: row for row in (item_rows or [])}
        active_claim_ids = {row["claim_id"] for row in active_custody}
    except Exception:
        st.error("Staff recovery records couldn’t be loaded. Check the advanced Supabase setup and try again.")
        return

    pending = [claim for claim in approved_claims if claim["id"] not in active_claim_ids]
    st.markdown("#### Approved claims ready for a staff check")
    if not pending:
        st.caption("No approved claims are waiting for a handover review.")
    for claim in pending:
        item = items_by_id.get(claim["item_id"], {})
        with st.container(border=True):
            st.markdown(f"**{html.escape(str(item.get('item_name') or 'Found item'))}** · {html.escape(str(item.get('category') or 'Item'))}")
            st.caption(f"Reported at {html.escape(str(item.get('location') or 'campus location'))}")
            st.markdown("**Private ownership detail from claimant**")
            st.write(claim.get("ownership_proof") or "No detail provided")
            if claim.get("message"):
                st.markdown("**Claimant’s message**")
                st.write(claim["message"])
            if st.button("Start staff handover check", key=f"start-custody-{claim['id']}", type="primary"):
                try:
                    client.rpc("start_campus_handover", {"p_claim_id": claim["id"]}).execute()
                    st.success("The item is now recorded for an in-person staff check.")
                    st.rerun()
                except Exception:
                    st.error("Couldn’t start the handover. Confirm the claim is approved and try again.")

    st.markdown("#### Items currently with campus staff")
    if not active_custody:
        st.caption("No items are currently recorded in staff custody.")
    for custody in active_custody:
        item = items_by_id.get(custody["item_id"], {})
        with st.container(border=True):
            st.markdown(f"**{html.escape(str(item.get('item_name') or 'Found item'))}** · In staff custody")
            st.caption(f"Claim reference: {custody['claim_id']}")
            with st.form(f"custody-checks-{custody['id']}"):
                identity = st.checkbox("Claimant identity checked in person", value=bool(custody.get("identity_checked")), key=f"identity-{custody['id']}")
                item_check = st.checkbox("Item details checked against the private claim", value=bool(custody.get("item_checked")), key=f"itemcheck-{custody['id']}")
                recipient = st.checkbox("Recipient acknowledged the handover", value=bool(custody.get("recipient_acknowledged")), key=f"recipient-{custody['id']}")
                saved = st.form_submit_button("Save handover checks")
            if saved:
                try:
                    client.table("campus_custody").update({
                        "identity_checked": identity,
                        "item_checked": item_check,
                        "recipient_acknowledged": recipient,
                    }).eq("id", custody["id"]).eq("status", "in_custody").execute()
                    st.success("Handover checks saved.")
                    st.rerun()
                except Exception:
                    st.error("The checks couldn’t be saved. Please try again.")
            complete_checks = all(custody.get(key) for key in ("identity_checked", "item_checked", "recipient_acknowledged"))
            if not complete_checks:
                st.caption("Save all three checks before recording the handover.")
            if complete_checks and st.button("Confirm item returned", key=f"finish-custody-{custody['id']}"):
                try:
                    client.rpc("complete_campus_handover", {"p_custody_id": custody["id"]}).execute()
                    st.success("The handover is recorded and the report is closed.")
                    st.rerun()
                except Exception:
                    st.error("Couldn’t complete the handover. Confirm all checks are saved, then try again.")
