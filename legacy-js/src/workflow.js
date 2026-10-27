export const CLAIM_STATUS = Object.freeze({
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  NEEDS_INFORMATION: 'More information required',
  DISPUTED: 'Disputed',
  ACCEPTED: 'Approved for in-person verification',
  HANDOVER_PENDING: 'Handover pending',
  REJECTED: 'Rejected',
  RECOVERED: 'Recovered'
});

const TRANSITIONS = Object.freeze({
  [CLAIM_STATUS.SUBMITTED]: [CLAIM_STATUS.UNDER_REVIEW, CLAIM_STATUS.NEEDS_INFORMATION, CLAIM_STATUS.ACCEPTED, CLAIM_STATUS.REJECTED, CLAIM_STATUS.DISPUTED],
  [CLAIM_STATUS.UNDER_REVIEW]: [CLAIM_STATUS.NEEDS_INFORMATION, CLAIM_STATUS.ACCEPTED, CLAIM_STATUS.REJECTED, CLAIM_STATUS.DISPUTED],
  [CLAIM_STATUS.NEEDS_INFORMATION]: [CLAIM_STATUS.UNDER_REVIEW, CLAIM_STATUS.ACCEPTED, CLAIM_STATUS.REJECTED, CLAIM_STATUS.DISPUTED],
  [CLAIM_STATUS.DISPUTED]: [CLAIM_STATUS.UNDER_REVIEW, CLAIM_STATUS.REJECTED],
  [CLAIM_STATUS.ACCEPTED]: [CLAIM_STATUS.HANDOVER_PENDING, CLAIM_STATUS.REJECTED, CLAIM_STATUS.DISPUTED],
  [CLAIM_STATUS.HANDOVER_PENDING]: [CLAIM_STATUS.DISPUTED],
  [CLAIM_STATUS.REJECTED]: [],
  [CLAIM_STATUS.RECOVERED]: []
});

export function allowedClaimTransitions(status) {
  return [...(TRANSITIONS[status] || [])];
}

export function validateClaimCreation(report, claimantId, claims=[]) {
  if (!report || report.kind !== 'found') return 'A claim must reference a found report.';
  if (!report.approved || !['active','open'].includes(report.status)) return 'This found report is not available for claims.';
  if (!claimantId || claimantId === report.owner) return 'You cannot claim a report you submitted.';
  const active = claims.some(claim => claim.reportId === report.id && claim.owner === claimantId && ![CLAIM_STATUS.REJECTED, CLAIM_STATUS.RECOVERED].includes(claim.status));
  if (active) return 'You already have an active claim for this item.';
  if (claims.some(claim => claim.reportId === report.id && [CLAIM_STATUS.ACCEPTED, CLAIM_STATUS.HANDOVER_PENDING, CLAIM_STATUS.RECOVERED].includes(claim.status))) return 'This item already has an accepted or completed claim.';
  return null;
}

export function validateClaimTransition(claim, nextStatus, { actorRole, actorId, report, claims=[] }={}) {
  if (actorRole !== 'staff') return 'Only the demo staff reviewer can change a claim status.';
  if (!claim || !report || report.kind !== 'found' || claim.reportId !== report.id) return 'The claim is not linked to a valid found report.';
  if (claim.owner && actorId === claim.owner) return 'A claimant cannot review or approve their own claim.';
  if (!allowedClaimTransitions(claim.status).includes(nextStatus)) return `Cannot move a claim from ${claim.status || 'unknown'} to ${nextStatus}.`;
  if ([CLAIM_STATUS.ACCEPTED, CLAIM_STATUS.HANDOVER_PENDING, CLAIM_STATUS.RECOVERED].includes(nextStatus) && claims.some(other => other.id !== claim.id && other.reportId === report.id && [CLAIM_STATUS.ACCEPTED, CLAIM_STATUS.HANDOVER_PENDING, CLAIM_STATUS.RECOVERED].includes(other.status))) return 'Another claim already has an accepted or completed handover for this item.';
  if (nextStatus === CLAIM_STATUS.ACCEPTED && report.status === 'recovered') return 'This item has already been handed over.';
  return null;
}

export function validateHandover({ actorRole, actorId, claim, report, custody, claims=[] }={}) {
  if (actorRole !== 'staff') return 'Only the demo staff reviewer can complete handover.';
  if (claim?.owner && actorId === claim.owner) return 'A claimant cannot complete their own handover.';
  if (!claim || !report || claim.reportId !== report.id || report.kind !== 'found') return 'The custody, claim, and found report must all be linked.';
  if (claim.status !== CLAIM_STATUS.HANDOVER_PENDING) return 'The claim must be approved and accepted into custody first.';
  if (!custody || custody.claimId !== claim.id || custody.reportId !== report.id || custody.status !== 'in custody') return 'An active custody record is required.';
  if (!custody.identityChecked || !custody.itemChecked || !custody.recipientAcknowledged) return 'Complete all three handover checks first.';
  if (['recovered','withdrawn','rejected','closed'].includes(report.status) || claim.status === CLAIM_STATUS.RECOVERED || custody.status === 'released') return 'This item has already been handed over or closed.';
  if (claims.some(other => other.id !== claim.id && other.reportId === report.id && [CLAIM_STATUS.HANDOVER_PENDING, CLAIM_STATUS.RECOVERED].includes(other.status))) return 'Another claim already has an active or completed handover.';
  return null;
}

export function validateMessageText(text, maxLength=1000) {
  const value = String(text ?? '').trim();
  if (!value) return { valid:false, value:'', error:'Enter a message before sending.' };
  if (value.length > maxLength) return { valid:false, value, error:`Messages must be ${maxLength} characters or fewer.` };
  return { valid:true, value, error:null };
}

export function conversationParticipants(claim, report) {
  if (!claim || !report || report.kind !== 'found' || claim.reportId !== report.id) return null;
  if (!claim.owner || !report.owner || claim.owner === report.owner) return null;
  return { claimantId:claim.owner, finderId:report.owner };
}

export function canAccessConversation(claim, report, actorId) {
  const participants = conversationParticipants(claim, report);
  return !!actorId && !!participants && [participants.claimantId, participants.finderId].includes(actorId);
}

export function orderedConversationMessages(messages, claimId, reportId) {
  return messages.filter(message => message.claimId === claimId && message.reportId === reportId)
    .slice().sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
}
