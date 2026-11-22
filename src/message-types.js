// The names of the support thread's six message types. Kept apart from src/chat/ so that the
// agent's side (tools, planner, threads.js) can name a type without importing anything that
// could reach the chat service.
export const TYPES = Object.freeze({
  NOTE: "SG:Note",
  RETURN_REQUEST: "SG:ReturnRequest",
  READING: "SG:Reading",
  OFFER: "SG:Offer",
  OFFER_ACCEPTED: "SG:OfferAccepted",
  CASE_CLOSED: "SG:CaseClosed",
});
