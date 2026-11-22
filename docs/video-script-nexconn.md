# Shade Guard on Nexconn: demo video script

The film for the Nexconn Build Challenge 2026: the support chat between a shopper and the store's
returns desk, on the Nexconn Chat SDK. The shop film for the YouCam hackathon is a separate script,
`docs/video-script.md`.

**Length: at most 3:00.** The challenge sets no length. The narration below was measured on
16 Nov 2026 with macOS `say` at rate 140: each still is held for its sentence plus a 0.16 s lead and
a 0.30 s tail, in whole 40 ms frames, a narrated still for at least 2.4 s and a silent one for 1.6 s.
That totals **2:38.6 (158.6 s)**, which leaves 180 − 158.6 = 21.4 s of headroom. The durations are
measured again at render, from the same sentences.

**How it is made.** Every picture but the closing card is a screenshot of the real support-chat page: the returns desk on
the left and the shopper's phone on the right, two separate apps in two frames of one page, each
connected to the chat service as its own demo user. A headless browser presses their own buttons and
types into their own fields, and each still is held for exactly as long as its sentence takes.
Nothing is drawn over the app, and no state is staged: every refusal on screen is the app's answer
to that click. The page is opened on one seat with a fresh visit id, so the thread starts empty for
this film. English narration, no music.

**What the final cut requires.** The film is made from the live demo's chat page,
https://guptachetan1995.github.io/shade-guard/chat.html. The build refuses a final cut unless, on
every still, both panes read **Connected**, no pane shows the offline service's pill or banner, and
every message's evidence line names Nexconn. A draft can be made on the offline stand-in that
`npm start -- --fake-chat` serves; its narration and closing card say so, and it is never uploaded.

**What is spoken, and what is not.** The only numbers spoken are R-104's shade reading, which is
fixture data the desk shows as it is: 245W at ΔE00 2.10, 250W at 3.51, 220N at 5.00. No time
measured on Nexconn is spoken. The server times and message ids are on screen, on every message,
as the service stamped them.

<!-- if-two-pages
Applies only if the live check finds that two Nexconn connections can't share one page (the desk
and the phone interfering through the page's shared storage, even with the phone's frame made
credentialless). The phone then opens in a private window beside the desk. Replace the first
sentence of "How it is made" with: "Every picture but the closing card is a screenshot of the real
support chat: the returns desk in one window and the shopper's phone in a private window beside it,
each connected to the chat service as its own demo user." The film then needs a second page for the
phone, and beats 1b, 2b, 5b, 7b and 10c frame the two windows side by side. The film builder films
one page holding both panes; a two-window film is not built, and the builder stops on a page
without the phone's frame.
-->

## Shot list

Start and hold are seconds, from the 16 Nov measurement.

| # | Still | Start | Hold | On screen | Action | Narration |
|---|---|---|---|---|---|---|
| 1a | b01a-page | 0.00 | 4.64 | The whole chat page: its title, seat and visit, both panes below | Open the page; wait until both panes read Connected | An opened foundation in the wrong shade is a return the store can't resell. |
| 1b | b01b-panes | 4.64 | 12.12 | Both panes, each with its green Connected badge; Maya's order O-5521 on the phone; the desk's inbox with R-104 and R-107 | Scroll the page to the panes | Here the conversation about it runs on the Nexconn Chat SDK: the returns desk on the left, the shopper's phone on the right. They are two separate apps that share nothing but a Nexconn channel. |
| 2a | b02a-order | 16.76 | 7.12 | The phone: order O-5521, Skin Tint 220N, **Start a return: wrong shade, opened** | Scroll the phone to the button | Maya opened her 220N, and it is the wrong shade. From her order, she taps Start a return. |
| 2b | b02b-sent | 23.88 | 1.60 | The phone: "Return requested", and the request in her chat | Phone: **Start a return** | *(silent)* |
| 3 | b03a-desk | 25.48 | 7.60 | The desk: the request in R-104's thread, "via Nexconn, hh:mm:ss, <message id>" with its full message id | Wait for the request on the desk | It reaches the desk with its Nexconn server time and its message id, so you can see that it crossed the network. |
| 4a | b04a-draft | 33.08 | 16.08 | The desk: the agent's draft, **Not sent**, an exchange offer for 245W listing 245W 2.10, 250W 3.51, 220N 5.00; the agent's run, list_return_cases → read_thread → draft_return_resolution → draft_reply | Wait for the agent's draft | The agent reads the thread and the shade reading on her order, and drafts an exchange: 245W at Delta E 2.1 from her reading, against 3.5 for 250W and 5.0 for the 220N she has. |
| 4b | b04b-unsent | 49.16 | 4.12 | The desk: **Send**, and "Only a staff click sends. A send reads the thread from the chat service first and is refused if the customer has written since the draft." | Scroll the desk to the line | It is only a draft. The agent has no way to send it. |
| 5a | b05a-typed | 53.28 | 5.00 | The phone: "is 250W any closer?" typed in her message box | Phone: type the question | Before staff reply, she asks: is 250W any closer? |
| 5b | b05b-sent | 58.28 | 1.60 | The phone: her question in the chat with its server time | Phone: **Send** | *(silent)* |
| 6a | b06a-send | 59.88 | 9.32 | The desk: **Refused: thread_moved.** "The customer has written since this draft was made, so it was not sent." | Desk: **Send** | Staff click Send. The desk first reads the thread back from Nexconn, finds her message, which the draft never saw, and refuses the send. |
| 6b | b06b-redraft | 69.20 | 4.88 | The desk: her question in the thread, and a new draft "written against" her message | Scroll the desk to her question | Her question is on screen now, and the agent drafts again against the new thread. |
| 7a | b07a-typed | 74.08 | 3.96 | The desk: "250W is ΔE00 3.51 from your reading; 245W is closer at 2.10." typed in **Your own words to the customer** | Desk: type the note | Staff answer her in their own words, from the numbers on screen. |
| 7b | b07b-sent | 78.04 | 3.08 | Both panes: the note, labelled "Staff · their own words" | Desk: **Send note** | That note is theirs, not the agent's. |
| 8 | b08a-offer | 81.12 | 5.84 | The phone: the offer card, **Exchange offer: 245W**, with **Accept** | Desk: **Send** | Then staff send the offer. On her phone it arrives as an offer card with an Accept button. |
| 9 | b09a-refused | 86.96 | 5.72 | The desk: **Refused: not_accepted.** "The shopper has not accepted offer … in the chat, so it can't be approved." | Desk: **Approve exchange** | An approval before she accepts is refused. The exchange waits for her own tap. |
| 10a | b10a-accepted | 92.68 | 2.40 | The desk: "Accepted the store's offer" from the shopper | Phone: **Accept** | She taps Accept. |
| 10b | b10b-approved | 95.08 | 2.48 | The desk: "Exchange approved by staff: 245W (simulated)." | Desk: **Approve exchange** | Now staff can approve the exchange, |
| 10c | b10c-closed | 97.56 | 2.40 | The phone: "Case closed by staff (resolved)" and "The store closed this case. The chat is read-only." | Desk: **Close case** | and close the case. |
| 11a | b11a-asha | 99.96 | 7.84 | The phone is now Asha's (order O-5530, "awaiting check"); the desk's inbox marks R-107 unread (1), a count the desk keeps from what it has shown | Phone: **Switch to Asha's phone**, then **Start a return** | A second shopper, Asha, starts a return on the same desk, in her own channel, and the desk marks her case unread. |
| 11b | b11b-invite | 107.80 | 5.96 | The desk, R-107: "No shade reading on this order"; the agent's draft, a check invite | Desk: open R-107 in the inbox | Her order has no shade reading, so the agent can only draft an invitation to check her shade. |
| 11c | b11c-sent | 113.76 | 2.40 | The phone: the invitation, labelled "Staff · the agent's draft, sent by staff" | Desk: **Send** | Staff send it. |
| 12a | b12a-check | 116.16 | 4.08 | The phone: **Check your shade**, its "Sample data: this check uses the app's synthetic sample shopper, not a real face" line, and **Share my reading** | Phone: **Check my shade** | Her own tap runs the check, here on the app's sample face. |
| 12b | b12b-shared | 120.24 | 5.76 | The phone: the reading card, "Shade reading, numbers only", L\*, a\*, b\*, hue, band and light, "No photo is ever in the thread." | Phone: **Share my reading** | Share my reading sends the result as numbers only. No photo is ever in the thread. |
| 13 | b13a-exchange | 126.00 | 6.76 | The desk, R-107: her reading card, and the agent's exchange draft citing it | Wait for the agent's draft | The desk records her reading from the chat, and the agent drafts the exchange it supports, for staff to send. |
| 14 | b14a-restored | 132.76 | 6.16 | The desk after a reload: R-104's thread back, from the return request to "Case closed", each with its server time and id | Reload the desk's frame; wait for the thread | Reload the desk, and the thread comes back from Nexconn's message history, the closed case included. |
| 15 | b15a-refused | 138.92 | 10.04 | The desk, **Try it as the agent**: "send_reply as the agent: wrong_actor", and "Messages in this thread before and after: desk n → n; chat service n → n. Nothing reached the thread." | Desk: **Send the draft** in Try it as the agent | And the agent? Its own call to send is refused at the same chokepoint the buttons use, and the thread on Nexconn holds as many messages after as before. |
| 16 | b16-close | 148.96 | 9.60 | Closing card: "Shade Guard · a buyer–store support chat on the Nexconn Chat SDK"; "Direct channels · six custom message types · real-time receipt · message history"; "The agent drafts. Only people send, accept, approve or close."; the live demo and the code; "The store, the shoppers and the face reading are fictional sample data." | — | Shade Guard. The agent drafts, and only people send, accept, approve or close. The live demo and the code are linked below. |

## Findings from the dry run on the offline stand-in (16 Nov 2026)

The whole path was run end to end against `npm start -- --fake-chat`, seat 1, one fresh visit, and
a still taken at each row above (26 browser stills). No Nexconn connection was involved.

- Every click answered as the table says: the send refused as `thread_moved` with her question on
  the desk, and the new draft written against her question; the note shown as staff's own words on both sides; the approval refused as
  `not_accepted`; the Accept, the approval and the close; Asha's case marked unread (1); the check
  invite; her check and the numbers-only card; the new exchange draft for R-107 ("Not sent ·
  exchange offer", not the sent invite, which also says "free exchange"); the reload; and the
  agent's send refused as `wrong_actor`, with the same message count before and after.
- After `thread_moved` the agent's new draft carries the same exchange text, written against her
  message. The agent does not read her words; staff answer her question in their own note.
- R-107's offer comes from the app's synthetic sample face (on the dry run: 245W 1.93, 250W 3.10,
  220N 4.62). These numbers are not spoken.
- After the reload the closed case stays closed, because the close is itself a message in the
  thread. Drafts and approvals live in the tab, so the reloaded desk drafts R-107's offer again.
- The first frame of the page shows the page's own title, seat and visit; the panes fill the rest.

## Not in the film, on purpose

The shop's own check on the cart, the merchant panel and the YouCam provider (the shop film covers
them); the connection states other than Connected (seat busy, offline, SDK not loaded, thread not
verified), which the README lists.

## Checklist against the rules

- "A video that shows your main features working": the Nexconn thread both ways, the custom
  message cards, real-time receipt with server times, history after a reload, and the human-only
  gate (beats 2 to 15).
- "Use a YouTube, Vimeo, Loom or Google Drive link. Make sure that anyone with the link can watch
  it": YouTube, Visibility **Public**.
- At most 3 minutes; English narration; no music.
