# Nexconn notes

The support chat's contract with the Nexconn Chat SDK: which names the adapter relies on, every
behaviour it assumes but nobody has seen yet, and the first live run's order of work.

**Status (22 Nov 2026): live on Nexconn since 22 Nov 2026** (App Key `y745wfm8ynetv`, Singapore).
What the first live run settled and measured is under
[Results of the live run](#results-of-the-live-run). Still not checked live: the catch-up after a
dropped connection (U12, U24), the echo of a user's own sends to another tab (U13), the service's
own unread counts (U19 to U23), and a busy-seat kick, which the service did not produce (U11).

## How the SDK reaches the page

- `chat.html` carries an import map that resolves `@nexconn/chat` and `@nexconn/engine` to
  `https://cdn.jsdelivr.net/npm/@nexconn/<name>@26.2.1/index.mjs`, with a `sha384` integrity value
  for each URL. The chat module imports the engine by its bare name, which is why both are mapped.
  A test pins the versions, the host and both hashes.
- `public/chat-sdk.js` is the only module that imports `@nexconn/chat`. The lint allows that one bare
  import in that one file, and lets only `public/chat/common.js` import the loader or the adapter.
  The agent's tools can import neither.
- No SDK file is copied into this repository or into the static build: the SDK loads at run time
  from the CDN, under Nexconn's own licence (the `LICENSE` file inside the package).
- A static build carries the demo tokens only when both `NEXCONN_SEATS_FILE` names the seats file and
  `NEXCONN_PUBLISH_TOKENS=1` is set. It then needs the Nexconn env file (whose App Key must be the
  seats file's), scans every file it wrote for the App Secret's value and removes itself on a hit.
  `npm run nexconn:tokens -- --scan <dir>` runs the same scan on any folder and prints file names
  only.
- The SDK has three ways to fail on the page, and each shows the "SDK not loaded" state with its
  reason: the CDN cannot be reached, the bytes fail their integrity check, or the module loads without
  a name the adapter uses.

## The names the adapter uses (26.2.1 typings, in our own words)

Read from the published `index.d.ts` of both packages on 16 Nov 2026. Nothing from them is copied
here or anywhere in the repository.

| Name | What the typings declare | How the adapter uses it |
|---|---|---|
| `NCEngine.initialize(params)` | Static, returns nothing. Takes the App Key, an optional log level (default WARN) and an optional area code (default Singapore) | Called once per page, inside `connect()`, with `AreaCode[...]` and `LogLevel.WARN` read from the module |
| `NCEngine.registerCustomMessages(list)` | Static. Each entry names `messageType`, `isPersisted`, `isCounted`, and optionally `isStatusMessage` and a remote-file field. The typings say to call it after initialize and before any message of those types arrives | The six `SG:` types, after initialize and before connect. The key is `isPersisted`; the web docs spell it `isPersited`, which the SDK would ignore |
| `NCEngine.connect({ token })` | Static, resolves to a result object whose `data` holds the connected `userId` | A wrong user id in the answer closes the connection and reads as offline |
| `NCEngine.disconnect(disablePush?)` | Static, resolves when done | Called after both handlers are removed, so our own disconnect reads as idle |
| `NCEngine.addMessageHandler(id, handler)`, `removeMessageHandler(id)` | A handler is registered under a string id | Id `shade-guard` |
| `MessageHandler({ onMessageReceived })` | `onMessageReceived` gets an event with a `messages` list (live or offline sync); there are many other optional callbacks | Only `onMessageReceived` |
| `NCEngine.addConnectionStatusHandler(id, handler)`, `removeConnectionStatusHandler(id)` | As above | Id `shade-guard` |
| `ConnectionStatusHandler({ ... })` | The typed callback is `onConnectionStatusChanged({ status, code? })`; the typings' own examples call it `onConnectionStateChanged` | Only the typed name is registered (U1) |
| `ConnectionStatus` | The engine's connection enum, re-exported: connected 0, connecting 1, disconnected 2, suspended 3 (suspended: the SDK retries after 5 s) | Mapped below |
| `AreaCode` | Beijing 1, Singapore 2 (the default), North America 3, `SA` 5 (its comment is unclear about which region), Oman 6 | `SG` and `NA` map by name; `SAU` maps to `SA` |
| `ChannelType` | Direct 1, group 3, open 4, system 6, community 10 | Only direct-channel messages reach the app |
| `LogLevel` | Debug 4 down to error 1 | WARN |
| `DirectChannel(userId)` | A channel with one other user; extends `BaseChannel` | One per send |
| `BaseChannel#sendMessage(params)` | Resolves to a result whose `data` is the sent `Message` | The message id and server time come from that answer |
| `SendMessageParams(content, messageType)` | A message to send, of any registered type | Content is a JSON copy of what the message table checked |
| `BaseChannel.createMessagesQuery(params)` | Static. Params: the channel identifier, `isAscending`, `pageSize` (default 20) and `startTime` (ms) | A fresh query for every load: `isAscending: false`, `pageSize` 21 (22 from a cursor) for pages of 20, and a `startTime` on every load after a read's first |
| `MessagesQuery#loadNextPage()`, `hasNext` | Resolves to a result whose `data` is a page `{ data: [...] }`; `hasNext` says whether more pages exist. A second load while one runs answers busy | Called once per query, never continued; see "Reading history" below |
| `DirectChannelIdentifier(userId)` | `channelType` and `channelId`; in a direct channel the id is the other user | The other user's id names the channel |
| `Message` | `messageId` (string), `sentTime` (ms), `senderUserId`, `direction` (1 sent, 2 received), `messageType`, `content`, `channelIdentifier`, and more | Turned into the interface's plain message |
| Result object (`NCResult`) | `isOk` (code 0), `code`, `msg`, optional `data` | Every SDK answer is checked through it |
| `BaseChannel.createChannelsQuery(params)`, `ChannelsQuery#loadNextPage()` | Static. Params: `pageSize` (default 20) and `startTime`. A plain query with no `hasNext`; a page is `{ data: [...] }` of channels | One fresh query of one page of 20 per read of the desk's unread counts, never continued |
| `BaseChannel#channelType`, `#channelId`, `#unreadCount` | Getters on a listed channel; `unreadCount` is "the unread message count for this channel" | Only direct channels whose id is one of the seat's shoppers; a count that is not a whole number is left out |
| `BaseChannel#clearUnreadCount()` | Resolves to a result object; clears the channel's unread count | Called on `new DirectChannel(peer)` when the desk shows that thread, or when nothing of this visit is unread in it |
| `ChannelHandler({ ... })`, `NCEngine.addChannelHandler(id, handler)`, `removeChannelHandler(id)` | `onChannelUnreadStatusSync({ channelIdentifier })` is "called when the channel's unread status is synced from another device"; there are many other optional callbacks | Only that one, id `shade-guard`, added before connect and removed first on release |
| Error codes | The engine's `ErrorCode` enum. `@nexconn/chat` does not re-export it, so the adapter holds the numbers | On a send: 30001, 30002, 30010, 30011, 30019 and 33001 read as offline; 30003 (no answer in time) and 20604 (sending too fast) as a failed send that can go again. For the connection: 31004, 31008, 31009, 31010, 31020, 31023 and 34006. On a history read: 33103 (busy) and 33007 (the app's cloud message history is off) |

### How a connection state reads on the page

| SDK state, code | Page state |
|---|---|
| connected | Connected |
| connecting | Connecting |
| suspended | Connecting, "the connection paused; the SDK reconnects by itself" |
| disconnected, 31010 or 31023 | Seat busy, with the code |
| disconnected, any other code | Offline, with the code and, for the common ones, words |
| anything else | Offline, "unknown Nexconn connection state" |

A send refused with 30001, 30002, 30010, 30011, 30019 or 33001 reads as `chat_offline`; any other
refusal, a thrown send, or an answer without a message id and server time is `send_failed` (so a
lost answer to an offer can be retried as the same draft).

### Reading history

A thread read asks for a page of 20, newest first, with a cursor for each older page. A `MessagesQuery`
continues by time, not by position: its next page asks again from the oldest time of the page before.
Where the service's `startTime` is exclusive, a message that shares that oldest millisecond but
missed the page would never be handed over, and the read would still look complete. So the adapter:

- never continues a query: every load is a fresh `MessagesQuery`, the first of a read with no
  `startTime` (it always asks the server), each later one at `startTime` = the oldest time the read
  has seen so far + 1, or the cursor's time + 1;
- keeps only messages strictly older than the cursor in (server time, message id) order, so the + 1
  is right whether `startTime` is inclusive or exclusive;
- hands a page out only once its oldest millisecond is complete, that is once it has seen a message
  older than that millisecond (the service orders by time, so nothing more of it can follow) or the
  channel has ended. The service's order inside one millisecond need not be the app's, so a page cut
  inside a millisecond could otherwise drop a message. Each load asks for one message more than the
  page (two more from a cursor, whose own message comes back first), so the extra, older message
  usually settles a page in one load;
- sorts every page itself, drops messages of other types and other channels, and tops a thinned page
  up, so a page shorter than 20 means the start of the channel and nothing else;
- refuses with `read_failed` (the desk then says "thread not verified" and sends nothing) when a
  load answers with an error, when a load hands over nothing new while the service still says there
  is more, or when one page takes more than ten loads. A run of ties can't be paged past by time:
  with an exclusive `startTime` that happens when one millisecond holds a whole load (21 messages, 22
  from a cursor); with an inclusive one, when two adjacent milliseconds together do. Either way the
  read fails closed.

## Every UNVERIFIED assumption

Written before the live run; what it settled is under [Results of the live run](#results-of-the-live-run). Where a review of the 26.2.1 package on 16 Nov 2026 reported
what to expect, the expectation is given; the live run checks each one and records the answer here.

| # | Assumption | Expected (16 Nov review) | How the live run checks it |
|---|---|---|---|
| U1 | The SDK calls the status handler by its typed name, `onConnectionStatusChanged` | Yes, only that name | `diagnostics()` shows `status` entries while connecting |
| U2 | `initialize` then `registerCustomMessages` then `connect` is enough for custom messages to persist and come back from history | | A reload restores an `SG:` message (the done-when of the live run) |
| U3 | A custom message's `content` comes back as the JSON object that was sent: numbers stay numbers, arrays stay arrays | | Share a reading (it carries an array) and compare both sides, and after a reload |
| U4 | The sent message's `messageId` and `sentTime` are the server's own, the same ones a history read returns | | Compare the `send` entry in `diagnostics()` with the same message in a later `newest` |
| U5 | A query asked with a `startTime` hands the newest messages older than that time | | The paging probe below: one `query` entry per load, pages of 20, 20 and the rest |
| U6 | `hasNext` turns false at the start of history | It is the server's own "more" flag | The paging probe: the last `page` entry says `hasNext: false` |
| U7 | A page's `data` is `{ data: [...] }` (a bare list is also accepted) | `{ data: [...] }` | The paging probe's page entries have the right `size` |
| U8 | Messages inside one page can come in any order (the adapter sorts) | Newest first on a descending query | No check needed; the sort holds either way |
| U9 | `startTime` on a descending query means "older than this time", and whether it is exclusive | Exclusive | Ask with a cursor from the middle of a channel and compare with the full read |
| U10 | The service's order inside one millisecond; that it never stamps a message older than one it has already shown | | Watch the paging probe's times; ties are rare |
| U11 | A kick by an eleventh connection of one user arrives as 31010 or 31023 | | Only if a kick is seen; otherwise recorded as "not observed" |
| U12 | A suspended connection is retried by the SDK and needs nothing from the page | | Turn the Mac's Wi-Fi off and on during a connected session |
| U13 | Whether `onMessageReceived` echoes a user's own sends to their other tabs | | Open the same seat's desk in a second tab and send from the first |
| U14 | The engine's local storage does not let two engines in two same-origin iframes interfere (the F7 check) | | The two-iframe check below |
| U15 | `SAU` is the SDK's `SA` area code | `SA` is 5, with hosts under `sau-light-edge.com` | Only matters if the app is in the Saudi Arabia data centre |
| U16 | The SDK's hosts | For Singapore: `dualstack-cloudcontrol` and `dualstack-nav` (both seen on 6 Nov), the WebSocket hosts `dualstack-ws` and `ws-b`, and `stats`, all under `sg-light-edge.com`, plus a bootstrap file on a cloud storage host. The navigation answer picks hosts and schemes at run time | DevTools, Network, the WS filter |
| U17 | The token and check scripts read the server API's answers by the field names `code` and `token`, and send `userId`, `name`, `userIds` and `expiresAt` | | `npm run nexconn:tokens` and `--check` succeed |
| U18 | `getServerTimeDelta()` is this tab's clock minus the server's | `Date.now()` minus the server time | A `send` entry: its local `at` minus the delta is close to its `sentTime` |
| U19 | The channel list's first page holds the desk's two direct channels, each with an `unreadCount` that grows by one for each received message of a type registered with `isCounted`, and never for the desk's own sends | | The unread check below: a `channels` entry with `listed: 1` after the shopper's first message, and the badge's number |
| U20 | A channel that has never carried a message is not listed at all (the desk then shows its own count for it, never a guessed 0) | | The unread check: before any message, `unreadCounts` answers `{}` |
| U21 | `clearUnreadCount()` sets the count to 0 on the service for every connection of the user, at once | | The unread check: after selecting the case, a second desk tab reads 0 |
| U22 | `onChannelUnreadStatusSync` fires in another tab of the same user when one tab clears a count ("another device" in the typings) | | The unread check: an `unread_sync` entry in the second tab's `diagnostics()` |
| U23 | Whether the channel list reads the server or the SDK's local copy, and whether its count already includes a message the moment `onMessageReceived` hands it over (the desk reads the counts about 30 ms after) | | The unread check: the badge appears with the message, not one message late |
| U24 | After a suspended connection comes back, whether the messages that reached the service meanwhile are handed to `onMessageReceived` (an offline sync) or not at all. The app no longer depends on it: on the way back to connected it reads each thread back from history, and a message it already holds is kept once | | The catch-up check below: the missed messages appear either way, each once; a `received` entry for them in `diagnostics()` says the SDK handed them over too |

The local server's policy for `chat.html` (only `npm start` sends one; GitHub Pages sends none)
lets scripts load from `https://cdn.jsdelivr.net/npm/@nexconn/` only, and keeps `connect-src 'self'
https: wss:` and `worker-src 'self' blob:` wide on purpose: the navigation answer decides the hosts
and the scheme at run time, and the bootstrap host is not recorded. Narrow it once the live run has
recorded what the SDK really reaches.

## The first live run, in order

Before it: the App Key and the app's data centre are known, `~/.config/shade-guard/nexconn.env`
(mode 600) holds `NEXCONN_APP_KEY`, `NEXCONN_AREA` and `NEXCONN_API_HOST`, and the App Secret line
was appended by the owner. Check only the file's mode and that the secret line has a value:

```bash
stat -f %Lp ~/.config/shade-guard/nexconn.env                                      # 600
grep -c '^NEXCONN_APP_SECRET=.' ~/.config/shade-guard/nexconn.env                   # 1
grep '^NEXCONN_APP_KEY=\|^NEXCONN_AREA=\|^NEXCONN_API_HOST=' ~/.config/shade-guard/nexconn.env
```

**1. Mint the demo users.**

```bash
npm run nexconn:tokens -- --seats 4
```

It prints the App Key and area, then each seat's three user ids with each token's length, and writes
`~/.config/shade-guard/nexconn-seats.json` (mode 600). What a failure means:

| It says | Meaning, and what to do |
|---|---|
| `signature refused` | The App Secret is wrong (a clipboard paste of something else). The owner re-appends it; never print it |
| `issuing <id> answered <code>` | The service refused the issue call, or answered in a shape other than U17. Read the code against the docs; the field names live in `scripts/nexconn-api.js` |
| `... is not the primary or backup host of area ...`, `NEXCONN_AREA must be one of ...` | The env file's area and host disagree; fix the env file, not the code |
| `... did not answer` | Both hosts timed out; check the network, then retry |
| `... already exists; expire its tokens and remove it first` | A seats file is already there; never mint twice |

**2. Check that every user exists, through the server API (no console page).**

```bash
npm run nexconn:tokens -- --check     # every id: exists
```

`not found (answer <code>)` means the user lookup's field names are not U17's, or the issue call did
not register the user.

**3. Start the local server.**

```bash
npm start
```

It prints `Support chat on Nexconn (App Key ..., area ..., 4 seats from ...)` and the chat page's
address. "The seats file ... is not valid" names the field to fix.

**4. The two-iframe check (F7), first, before anything else.** Open a **fresh** Chrome tab (an
integrity failure sticks to the tab it happened in) at
`http://127.0.0.1:5178/chat.html?probe=1`, then in DevTools:

```js
frames[0].sgProbe.status()          // the desk: { state: "connected", ... }
frames[1].sgProbe.status()          // the phone
frames[0].sgProbe.diagnostics()     // codes, pages, receipts; no token, no message content
```

1. Both panes show **Connected**, and stay so for a minute.
2. One message each way: on the phone, **Start a return**; on the desk the request appears with its
   evidence line `via Nexconn, <server time>, <the message id>` (the full id: on the live run the last six characters were the same for every message from one sender). On the desk, type a
   note and **Send note**; it appears on the phone.
3. Reload the whole page, then reload each pane on its own: each thread comes back from Nexconn's
   history, the custom messages included. This is the run's done-when (U2).

What a failure means:

| What you see | Meaning, and what to do |
|---|---|
| "SDK not loaded" with "valid digest" | The CDN's bytes are not the pinned ones. Do not change the hashes to make it load: a different file is a different SDK, and that is the owner's call |
| "SDK not loaded" with "could not load from the CDN" | jsDelivr is unreachable, or the import map did not run. A console line "Refused to ..." names the policy directive |
| "SDK not loaded ... without <names>" | The module loaded, but a name the typings promise is missing; record which |
| A console line "Refused to connect to ..." | The local server's policy, not Nexconn: widen `chatCsp` in `src/server.js` for that host and its scheme (the SDK picks `ws:` or `wss:`, and `http:` on an `http:` page, per host from the navigation answer) and record both here |
| A thread that says "not verified", and `read_failed` with 33007 in `diagnostics()` | The app's cloud message history is switched off in the Nexconn console: history can't be read at all. The owner's setting, if it has one |
| Offline, 31004 | The token is wrong for this App Key (a seats file from another app?) |
| Offline, 31008 | The Nexconn app is blocked or deleted (the Free plan's end, for one) |
| Busy, 31010 or 31023, on one pane as the other connects | The two engines share the origin's storage and step on each other: the F7 check failed |
| Messages arrive in the wrong pane, or a pane drops each time the other connects | The same: F7 failed |

**If F7 fails**, in this order:

1. The shopper's iframe with its own storage: `http://127.0.0.1:5178/chat.html?isolate=1&probe=1`
   (the phone's iframe gets `credentialless`). Repeat steps 1 to 3. Keep it only if it isolates
   the two.
2. One side per window: the desk at
   `http://127.0.0.1:5178/chat.html?side=desk&seat=1&visit=probe1&probe=1`, and the shopper in a
   private window (or on the phone) at
   `http://127.0.0.1:5178/chat.html?side=shopper&seat=1&visit=probe1&as=0&probe=1`. Each window is
   its own engine. A second ordinary tab is not a fallback: it shares the origin's storage just as an
   iframe does.

Record here which one passed.

**5. The paging probe (U4 to U10).** On one seat, in the desk pane's console, send 45 notes, about
300 ms apart (back-to-back sends can be refused as 20604, "sending too fast"), under a throwaway visit id (the app shows only its own visit, so the demo threads stay clean; they do add to
the seat's channel, well inside its 500-message read budget). The shopper's user id is
`frames[1].sgProbe.userId`:

```js
const desk = frames[0].sgProbe.transport, peer = frames[1].sgProbe.userId;
for (let i = 0; i < 45; i++) {
  await desk.send({ toUserId: peer, type: "SG:Note", content: { visit: "probe-paging", caseId: "R-104", text: `probe ${i}`, by: "staff" } });
  await new Promise((r) => setTimeout(r, 300));
}
const p1 = await desk.newest({ withUserId: peer, limit: 20 });
const p2 = await desk.newest({ withUserId: peer, limit: 20, before: p1.at(-1) });
const p3 = await desk.newest({ withUserId: peer, limit: 20, before: p2.at(-1) });
[p1.length, p2.length, p3.length]          // 20, 20, then what is left of the channel
frames[0].sgProbe.diagnostics().filter((d) => d.op === "query" || d.op === "page")
```

Look for: one `query` entry per load, each with a `startTime` one more than the oldest time read
before it (U5); page entries whose `size` is 21 (22 from a cursor) and whose last says `hasNext: false` (U6, U7); `p1[0].content.text` is `probe 44`, the newest; the ids and times of a sent note in
its `send` entry matching the same note in `p1` (U4). Then a cursor from the middle,
`desk.newest({ withUserId: peer, limit: 20, before: p1[9] })`, should start a new query with a
`startTime` and hand over exactly the messages after `p1[9]` in the full read (U9).

**5b. The unread check (U19 to U23).** In a fresh visit, before any message:
`await frames[0].sgProbe.transport.unreadCounts([frames[1].sgProbe.userId])` answers `{}` (U20).
On the phone, switch to Asha and **Start a return**: the desk's R-107 row shows a badge whose
`data-unread-source` is `service` and whose number is 1 (U19, U23). Open the same seat's desk in a
second tab (`chat.html?side=desk&seat=<n>&visit=<the visit>&probe=1`), then in the first select R-107:
the second tab's `sgProbe.transport.unreadCounts([...])` reads 0 (U21) and its `diagnostics()` holds
an `unread_sync` entry (U22). If the service's count misbehaves, the desk can be put back on its own
count by taking `unreadCounts` and `clearUnread` off the adapter (the badge then says "this desk's own
count"); the submission copy names the SDK's unread counts only if this check passed.

**5c. The catch-up check (U12, U24).** Open the desk alone in one window
(`chat.html?side=desk&seat=<n>&visit=<v>&probe=1`) and the phone in a private window
(`chat.html?side=shopper&seat=<n>&visit=<v>&probe=1`). In the desk window's DevTools, Network, set
**Offline**; the desk reads **Connecting…** (suspended) or **Offline**. From the phone, send two
notes. Set the desk back to **No throttling**. If the SDK reconnects by itself, the desk reads
**Connected** and the two notes appear in order, each once, with no staff send in between: that is
the catch-up read (`query` entries in `diagnostics()` right after the `status` entry that says
connected). If the desk stays **Offline** instead, the SDK does not reconnect from that state by
itself, and a reload is the way back (the page already says so); record which.

**6. Record here:** the WebSocket host and the HTTPS hosts (DevTools, Network), which status handler
name fired, every connect and kick code seen, the send-to-arrival time (on the receiving pane, a
`received` entry's local `at`, minus its `serverTimeDelta`, minus its `sentTime`; U18 says how to
check the delta's sign first), and the F7 result. Then fix what the run
showed, and change each UNVERIFIED mark it settled, in the code and in this file.

## What waits for the next slices

- The desk inbox's unread counts from the SDK's channel list are built and tested against the
  stand-in only (U19 to U23): a badge's `data-unread-source` says `service` when the count is the
  channel list's and `desk` when the desk counted it itself, and the line under the inbox says the
  same. The service's count is the channel's, so another visit on the same seat adds to it; the desk
  marks a channel read on the service when it shows the thread, or when nothing of its own visit is
  unread there (another or an earlier visit's messages).
- Typing indicators and read receipts. (The phone link on the desk is built: it carries only the
  seat number and the visit id, and the phone it opens reads its token from the seats file. Whether
  a real phone on the Pages demo connects through it is checked on the live run.)
- Narrowing the local policy's `connect-src` to the recorded hosts.
- **Open: a stale unread badge after a clear.** The desk clears a channel at most once per count it
  has seen (so a clear that does not take can't loop). If a new message brings the count back to
  exactly the value it just cleared, between the clear and the read after it, the desk takes the
  clear as not taken and shows the service's count until the count changes again. The badge is then
  one message high on the service's side for a while; the desk's own count and the thread are right.
- After the SDK reconnects by itself (a suspended connection), each side now reads its threads back
  through the same path a restore uses (the same 25-page budget; another visit's messages dropped; a
  message already held kept once), so messages sent meanwhile appear without waiting for the next
  staff send. A catch-up that stops at the budget short of the desk's read point keeps that read
  point and flags the gap, so staff sends still refuse as `thread_unverified`. Tested on the fake
  service and the stand-in only (U12, U24).

## Results of the live run

**Sun 22 Nov 2026, 10:30 to 11:00 IST, Bengaluru, on a Mac, Chrome and the app's in-app browser.**
App Key `y745wfm8ynetv`, Singapore data centre, created by the console on sign-up ("First
application", Chat Free).

- **Server API (U17, settled).** Every call answered HTTP 200 with a body `code`: the issue call
  `{ code: 0, result: { userId, accessToken } }` (tokens 96 characters for the seat ids, 84 for a
  shorter id); a user lookup `code: 0` with `result: { name, avatarUrl, createdAt }`, and `code: 400`
  for an unknown id; the expire call `{ code: 0 }`. The scripts first assumed `code: 200` and a
  top-level `token`, so the first mint stopped after one id (`sgdesk8c6b9697`, its token expired at
  once); they now read the real shapes, and the fake signer answers in them. Ids registered besides
  the 12 seat ids, for tests: 2 (`sgdesk8c6b9697` and a shape probe, `sgprobe01`), both expired.
  `npm run nexconn:tokens -- --seats 4` then minted 12 users, and `--check` found all 12.
- **The two-frame check (F7, U14): passed in two frames of one page**, without `?isolate=1`. Both
  panes connected, one message each way, then a reload of the page and of each pane on its own:
  both threads came back from Nexconn's history with the same ids and server times, custom messages
  included (U2). No 31010 or 31023 at any point.
- **Status handler (U1):** `status` entries `connecting` then `connected` on every connect.
- **Hosts (U16):** the SDK loaded from `cdn.jsdelivr.net` with the pinned hashes; HTTPS to
  `dualstack-cloudcontrol.sg-light-edge.com` (`/v1/config`); the WebSocket to
  `wss://ws.sg-light-edge.com` (read by wrapping the frame's `WebSocket` before the SDK connected;
  host only, never the address, which carries a token).
- **Paging (U4 to U9).** 45 notes from the desk, 300 ms apart, on seat 3: pages of 20, 20 and 5,
  newest first (`probe 44`), page sizes 21, 22 and 6, the last with `hasNext: false`; each later
  query's `startTime` is the oldest time read before it plus 1; a cursor from the middle
  (`before: p1[9]`) handed exactly the messages after it (exclusive); each `send` entry's id and
  time equal the same message in the history read. Every send answered 0 (no 20604 at 300 ms).
- **Send-to-arrival.** Over those 45 notes, desk to phone: the receiving pane's local time minus
  the service's `sentTime` was a median 223 ms (218 to 356); the receiving pane had each a median
  143 ms (139 to 277) after the sending pane's send call returned, both frames on one clock. The
  send call returned a median 80 ms (79 to 112) after the service's `sentTime`, so this Mac's clock
  and the service's agree to within that.
- **`getServerTimeDelta()` (U18): not trusted.** It read -427 ms in one session and -139 ms in
  another, and neither sign makes the timings above consistent; nothing uses it.
- **A second connection as the same user (U11):** a second tab on seat 3's desk connected while the
  first stayed connected, both for over 14 s; no kick was seen, so the busy-seat state was not seen
  live.
- **Unread counts (U19 to U23): not checked live.** The channel list answered 35011 at times (once
  on a channel that already held 46 messages), and the badge then showed the desk's own count, as
  designed. The copy names only the desk's own count.
- **Both cases end to end.** The film's live check (`--check --url http://127.0.0.1:5178/chat.html
  --seat 1`) ran R-104 and R-107 on Nexconn, every still guarded (both panes Connected, every
  message via Nexconn): the request, the agent's draft, her question and the `thread_moved` refusal,
  a staff note, the offer, `not_accepted` before her tap, her Accept, the approval and the close,
  then Asha's case with her shared reading (U3: the numbers render the same on both sides and after a
  reload), a reload, and the agent's refused calls.
- **One fix from the live run:** the evidence line showed the last six characters of the message
  id, and on Nexconn those repeat across one sender's messages (`…6-QOH2` on five of them). Every
  message now shows its full id.
- **Not checked live:** the catch-up after a dropped connection (U12, U24) and the echo of a user's
  own sends to another tab (U13).

## Token expiry (Wed 2 Dec 2026)

Not yet run. `npm run nexconn:expire -- --dry-run` lists the ids it would expire and sends nothing;
then `npm run nexconn:expire` expires every seat's tokens as of that moment, and its output (the ids
and the answer codes) goes here. It has no `--check`: like the token script, it refuses any flag it
does not take, and refuses `--backup-base` without `--base`.
