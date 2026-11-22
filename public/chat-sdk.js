// The one module that loads the Nexconn Chat SDK. chat.html's import map resolves the bare name to
// jsDelivr, pinned to 26.2.1 with an integrity hash for each of its two files (@nexconn/chat imports
// @nexconn/engine by its bare name, which the same map resolves), so the browser refuses any other
// bytes. No SDK file is copied into this repository or its static build: the SDK loads at run time,
// under Nexconn's own licence. scripts/lint.js lets this file, and no other, import a bare name.
export const SDK_MODULE = "@nexconn/chat";

export function loadNexconnSdk() {
  return import("@nexconn/chat");
}
