// How the page reaches api.js. Local runs post to the 127.0.0.1 server; the static demo
// (marked data-transport="pages" by the build) runs the same api.js, invoke() and store in
// this tab, replaying the recorded sample shopper when the build copied one (data-recording).
// Either way the page sees only plain JSON.

export async function createTransport() {
  const root = document.documentElement;
  if (root.dataset.transport === "pages") {
    const { createPagesTransport } = await import("../src/pages-entry.js");
    // The build marks the page with the recording's folder when it copied one.
    const base = root.dataset.recording ? new URL(root.dataset.recording, document.baseURI) : null;
    const read = base
      ? async (name) => {
          const res = await fetch(new URL(name, base));
          if (res.status === 404) return null;
          if (!res.ok) throw new Error(`the recording's ${name} answered ${res.status}`);
          return new Uint8Array(await res.arrayBuffer());
        }
      : null;
    return createPagesTransport({ read });
  }
  return {
    kind: "http",
    async request(method, path, body = null) {
      const res = await fetch(path, {
        method,
        headers: body === null ? {} : { "content-type": "application/json" },
        body: body === null ? undefined : JSON.stringify(body),
      });
      return res.json();
    },
  };
}
