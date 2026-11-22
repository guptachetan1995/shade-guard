// The words on screen for every connection state, and for the one action-level state the
// desk can land in when it could not read a thread. Pure data, so a test can check that no
// state is left without words.
import { STATUS } from "./transport.js";

export const STATE_WORDS = Object.freeze({
  [STATUS.IDLE]: { label: "Not connected", tone: "muted", words: "Not connected yet: the chat has not started, so nothing can be sent." },
  [STATUS.CONNECTING]: { label: "Connecting…", tone: "muted", words: "Connecting to the chat service. Nothing can be sent until it is connected." },
  [STATUS.CONNECTED]: { label: "Connected", tone: "ok", words: "Connected. Messages cross the chat service and each shows its server time." },
  [STATUS.OFFLINE]: {
    label: "Offline",
    tone: "bad",
    words: "Offline: the connection dropped. Nothing is sent while offline, and nothing here is faked. Reload to reconnect.",
  },
  [STATUS.BUSY]: {
    label: "Seat busy",
    tone: "bad",
    words: "This demo seat is busy: too many connections are using it. Open another seat.",
  },
  [STATUS.SDK_NOT_LOADED]: {
    label: "SDK not loaded",
    tone: "bad",
    words: "The Nexconn SDK is not loaded, so chat is off. Nothing is faked.",
  },
});

export const THREAD_NOT_VERIFIED = Object.freeze({
  label: "Thread not verified",
  words: "Nothing was sent: the desk could not read this thread from the chat service, so it cannot be sure it has seen every message.",
});

export function wordsFor(state) {
  return STATE_WORDS[state] ?? { label: String(state), tone: "muted", words: `Unknown chat state ${state}.` };
}
