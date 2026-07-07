# MyHome Connect — User Stories

**Application:** MyHome Connect (Internal Chat Platform)
**Tech Stack:** Vanilla JS · Firebase Firestore · Firebase Storage · WebRTC
**Last Updated:** July 2026

---

## Epic 1: Authentication

### US-001 — Sign In
**As a** registered user,
**I want to** sign in with my username and password,
**So that** I can access the chat application securely.

**Acceptance Criteria:**
- Username lookup is case-insensitive
- Wrong password shows a clear error message
- Successful login stores session and redirects to the chat
- Status is set to "Online" on login

---

### US-002 — Register
**As a** new user,
**I want to** create an account with a username and password,
**So that** I can start chatting with my team.

**Acceptance Criteria:**
- Duplicate usernames are rejected
- Passwords must be at least 4 characters
- Password confirmation must match
- Account is created with a unique color avatar
- User is auto-logged in after registration

---

### US-003 — Logout
**As a** logged-in user,
**I want to** log out of the application,
**So that** my session is cleared and my status shows as Offline.

**Acceptance Criteria:**
- All Firestore listeners are unsubscribed on logout
- Session storage is cleared
- User status updates to "offline" in Firestore
- Redirected to the login page

---

## Epic 2: Messaging

### US-004 — Send a Message
**As a** user,
**I want to** type and send a text message to a channel or direct message,
**So that** others in the conversation can read it in real time.

**Acceptance Criteria:**
- Press Enter to send (desktop); Enter also sends on mobile
- Press Shift+Enter to add a new line (desktop)
- Textarea auto-resizes up to 120px height
- Empty messages are not sent
- Message appears instantly (optimistic render)

---

### US-005 — Send a Multiline Message
**As a** user,
**I want to** write messages that span multiple lines,
**So that** I can format longer content clearly.

**Acceptance Criteria:**
- Shift+Enter inserts a new line on desktop
- A dedicated ↵ button inserts a new line on mobile
- Line breaks are preserved in the rendered message

---

### US-006 — Send Emoji
**As a** user,
**I want to** insert emoji into my messages using a picker,
**So that** I can express reactions and emotions easily.

**Acceptance Criteria:**
- Emoji picker opens above the input bar
- Categories: Recent, Smileys, Gestures, Hearts, Nature, Food, Activity, Symbols
- Search filters emoji in real time
- Recently used emoji appear at the top
- Emoji-only messages render large (42px) without a bubble background

---

### US-007 — Attach Files
**As a** user,
**I want to** attach one or more files to a message,
**So that** I can share documents and images with the team.

**Acceptance Criteria:**
- Multiple files can be selected at once
- Images show a thumbnail preview before sending
- Files can be removed from the preview before sending
- A caption can be typed alongside the file
- Images render inline in the chat; other files render as download links
- Upload progress is shown with a faded optimistic message

---

### US-008 — Paste Image
**As a** user,
**I want to** paste a screenshot or copied image directly into the chat input,
**So that** I can share images quickly without using the file picker.

**Acceptance Criteria:**
- Ctrl+V in the message input captures clipboard images
- Pasted image is added to the file preview bar
- Image is uploaded and sent on submit

---

### US-009 — Drag and Drop Image
**As a** user,
**I want to** drag an image file onto the chat window,
**So that** I can share images without navigating a file browser.

**Acceptance Criteria:**
- A visual drag-over overlay appears when a file is dragged over the chat
- Dropped image is added to the file preview bar ready to send

---

### US-010 — Real-Time Message Updates
**As a** user,
**I want to** see new messages appear instantly without refreshing,
**So that** conversations flow naturally.

**Acceptance Criteria:**
- Messages from others appear in real time via Firestore onSnapshot
- The view auto-scrolls to the newest message when already at the bottom
- Date dividers (Today / Yesterday / full date) group messages by day

---

### US-011 — Clickable Links
**As a** user,
**I want** URLs in messages to be clickable,
**So that** I can open links without copying and pasting.

**Acceptance Criteria:**
- http:// and https:// URLs are automatically converted to `<a>` links
- Links open in a new tab

---

## Epic 3: Message Actions (Right-Click Menu)

### US-012 — Open Action Bar
**As a** user,
**I want to** right-click (desktop) or long-press (mobile) a message,
**So that** a floating action bar appears with options for that message.

**Acceptance Criteria:**
- Right-click on desktop opens the action bar at the cursor position
- Long-press (700ms without movement) on mobile opens the bar near the touch point
- The bar stays open until I click outside it or press Escape
- The bar closes cleanly when I choose an action

---

### US-013 — Reply / Quote a Message
**As a** user,
**I want to** reply to a specific message by quoting it,
**So that** the context of my response is clear.

**Acceptance Criteria:**
- Clicking Reply in the action bar shows a quote preview above the input
- The preview shows the original sender and a text excerpt
- Sending includes the quote block in the message bubble
- Clicking a quote block scrolls to and highlights the original message
- Only the direct message text is quoted, not any nested quotes within it

---

### US-014 — React with Quick Emoji
**As a** user,
**I want to** quickly react to a message with a common emoji (👍 ❤️ 😂),
**So that** I can respond without typing.

**Acceptance Criteria:**
- Like, Love, and Haha buttons are visible in the action bar
- Clicking a reaction adds it with a count chip below the message
- Clicking the same reaction again removes it (toggle off)
- Multiple users can react with the same emoji; the count increments

---

### US-015 — React with Any Emoji
**As a** user,
**I want to** react to a message with any emoji from a full picker,
**So that** I'm not limited to the three quick-react options.

**Acceptance Criteria:**
- Clicking ＋ in the action bar opens a searchable emoji grid (130+ emoji)
- Selecting an emoji adds it as a reaction and closes the picker
- The picker closes when clicking outside it

---

### US-016 — Translate a Message
**As a** user,
**I want to** translate a message to English with one click,
**So that** I can understand messages written in another language.

**Acceptance Criteria:**
- Clicking 🌐 in the action bar inserts a translation block below the bubble
- Philippine languages are prioritized (Tagalog, Cebuano, Bikol, Ilocano, Hiligaynon, Waray, Kapampangan, Pangasinan)
- Code-switched messages (e.g. "5 days ngane yung deal") are detected and translated correctly
- The label shows the detected source language (e.g. "🌐 Filipino → EN")
- For single words, additional meanings by part-of-speech are shown (noun: …, verb: …)
- Already-English messages show "(already in English)"
- Clicking 🌐 again dismisses the translation
- Falls back to MyMemory then Lingva if Google Translate is unavailable

---

### US-017 — Copy a Message
**As a** user,
**I want to** copy a message's text to my clipboard,
**So that** I can paste it elsewhere.

**Acceptance Criteria:**
- If I have selected a portion of text, only that selection is copied
- If nothing is selected, the full message text is copied
- A confirmation toast appears after copying

---

### US-018 — Edit Own Message
**As a** user,
**I want to** edit a message I sent,
**So that** I can correct mistakes without deleting and retyping.

**Acceptance Criteria:**
- Edit option only appears on my own messages
- An inline edit row replaces the message with a textarea
- Press Enter to save or Escape to cancel
- "(edited)" tag appears on the message after saving
- Editing is blocked while offline

---

### US-019 — Delete a Message
**As a** user,
**I want to** delete a message,
**So that** I can remove something I sent by mistake.

**Acceptance Criteria:**
- "Delete for Everyone" permanently removes the message for all users (own messages only)
- "Delete for Me" hides the message only from my view
- An undo toast appears for 5 seconds before the delete is committed
- Clicking Undo within 5 seconds restores the message

---

### US-020 — Select and Copy Message Text
**As a** user,
**I want to** click and drag to select part of a message bubble,
**So that** I can copy only the portion of text I need.

**Acceptance Criteria:**
- Message bubble text is selectable (not read-only)
- Standard OS text selection and copy (Ctrl+C / long-press copy) works
- Mobile text selection handles appear correctly on long-press

---

## Epic 4: Channels

### US-021 — Create a Channel
**As a** user,
**I want to** create a new channel with a name and description,
**So that** the team can have organised topic-based conversations.

**Acceptance Criteria:**
- Channel name is required; duplicate names are rejected
- Optional description can be added
- Participants can be selected from the user list
- Channel appears immediately in the sidebar

---

### US-022 — Rename a Channel
**As a** user,
**I want to** rename an existing channel,
**So that** the channel label stays relevant as topics evolve.

**Acceptance Criteria:**
- Rename option is available via the ··· menu on each channel
- Topbar title updates immediately if the renamed channel is currently open

---

### US-023 — Manage Channel Participants
**As a** user,
**I want to** add or remove participants from a channel,
**So that** only relevant people are in each channel.

**Acceptance Criteria:**
- Participants are shown as a checklist of all users
- Changes are saved to Firestore immediately

---

### US-024 — Delete a Channel
**As a** user,
**I want to** delete a channel I created,
**So that** outdated or unused channels are cleaned up.

**Acceptance Criteria:**
- A confirmation prompt appears before deletion
- The channel is removed from Firestore and the sidebar
- If the deleted channel is currently open, the app navigates away

---

### US-025 — Filter / Search Channels and DMs
**As a** user,
**I want to** type in the sidebar search to filter channels and direct messages,
**So that** I can quickly find a conversation in a long list.

**Acceptance Criteria:**
- Filter applies to both channels and DMs simultaneously
- Matching is case-insensitive
- DM nickname overrides are respected in the filter

---

## Epic 5: Direct Messages

### US-026 — Start a Direct Message
**As a** user,
**I want to** open a direct message conversation with any other user,
**So that** I can have a private one-on-one chat.

**Acceptance Criteria:**
- ＋ New Message shows all users with their online status
- Users with existing conversations are labelled "existing"
- Selecting a user opens the DM and adds it to the sidebar list

---

### US-027 — Sort DMs by Recent Activity
**As a** user,
**I want** my direct message list sorted with the most recently active conversations at the top,
**So that** my busiest conversations are easy to find.

**Acceptance Criteria:**
- DM list order updates automatically when a new message is received
- Alphabetical order is used as a tiebreaker

---

### US-028 — Rename a DM Contact (View Only)
**As a** user,
**I want to** give a contact a custom nickname,
**So that** I can identify them by a name that makes sense to me.

**Acceptance Criteria:**
- Nickname is stored locally (localStorage) and visible only to me
- The real username is shown in parentheses in the rename dialog
- The topbar and DM list use the nickname

---

### US-029 — Delete DM for Me
**As a** user,
**I want to** hide a DM conversation from my view,
**So that** my DM list stays clean without affecting the other person.

**Acceptance Criteria:**
- All messages in the conversation are marked as hidden for me only
- The other person's view is unaffected

---

### US-030 — Delete DM for Everyone
**As a** user,
**I want to** permanently delete a DM conversation for both parties,
**So that** sensitive conversations can be fully removed.

**Acceptance Criteria:**
- A confirmation prompt warns that the action is irreversible
- All messages are deleted from Firestore
- Both users' views are cleared

---

## Epic 6: Unread & Notifications

### US-031 — Unread Message Badges
**As a** user,
**I want to** see a red badge with a count on channels and DMs that have new messages,
**So that** I know where to look for unread content.

**Acceptance Criteria:**
- Badge shows the number of unread messages since I last viewed the channel
- Channel/DM label turns bold and orange when unread
- Badge clears when I open the channel

---

### US-032 — Unread Tab Title and Favicon
**As a** user,
**I want** the browser tab title and favicon to reflect unread message counts,
**So that** I know there are new messages even when the tab is in the background.

**Acceptance Criteria:**
- Tab title shows "(N) MyHome Connect" when N > 0 unread messages
- Favicon changes to an orange badge with "!" when there are unread messages
- PWA app badge is updated via the Badging API on supported devices

---

### US-033 — Desktop Push Notifications
**As a** user,
**I want to** receive a desktop notification when a new message arrives and the window is not focused,
**So that** I don't miss important messages while working in another application.

**Acceptance Criteria:**
- A "🔔 Notify" button appears if notification permission hasn't been granted
- Clicking the button prompts the browser for notification permission
- Notifications show sender name, channel, and a message preview
- Clicking the notification focuses the window and opens that channel
- Notifications auto-close after 6 seconds
- No duplicate notifications for the same message

---

### US-034 — Mark as Read on Window Focus
**As a** user,
**I want** the current channel to be marked as read when I return to the browser window or tab,
**So that** seen receipts accurately reflect when I actually read the messages.

**Acceptance Criteria:**
- Messages are NOT marked as read if the tab is open but not focused
- Switching back to the tab triggers a seen update for the current channel
- Unread counts and bold labels clear when the window regains focus

---

### US-035 — Seen Receipts
**As a** user,
**I want to** see small avatars below my sent messages indicating who has read them,
**So that** I know my messages have been received.

**Acceptance Criteria:**
- A colour-coded avatar appears below the last message a recipient has seen
- Only one avatar per user — it moves to the latest message they've seen
- Hovering the avatar shows the user's name in a tooltip

---

## Epic 7: Members & User Management

### US-036 — View Members Panel
**As a** user,
**I want to** open a members panel showing all users and their status,
**So that** I can see who is online.

**Acceptance Criteria:**
- Panel slides in from the right side
- Each member shows their avatar, name, and status indicator (green/yellow/red/grey)
- "(you)" label marks the current user

---

### US-037 — Remove a User (Admin)
**As an** Admin user,
**I want to** remove a user and delete all their chat history,
**So that** I can manage access and clean up data when someone leaves.

**Acceptance Criteria:**
- Remove option appears on all users for Admin; on self for any user
- A confirmation prompt warns the action is irreversible
- All messages by the user across all channels and DMs are deleted
- The user's Firestore document is deleted
- If the user removes themselves, they are logged out immediately

---

### US-038 — Update Profile Settings
**As a** user,
**I want to** change my display name, status, and profile photo,
**So that** my profile stays up to date.

**Acceptance Criteria:**
- Settings modal opens from the ⚙️ button or avatar click
- Display name changes are reflected immediately in the sidebar and Firestore
- Status can be set to Online, Away, Busy, or Offline
- Profile photo can be uploaded (stored in Firebase Storage)
- Photo appears as a circular avatar in the sidebar, members panel, and message bubbles

---

## Epic 8: Search

### US-039 — Search Within a Conversation
**As a** user,
**I want to** search for keywords within the currently open conversation,
**So that** I can find specific messages without scrolling.

**Acceptance Criteria:**
- Search bar opens below the topbar via the 🔍 button
- Non-matching messages are hidden
- Matching keywords are highlighted in purple
- A count shows "N results"
- Date dividers without visible results are also hidden
- Closing the search restores all messages

---

## Epic 9: Video Calls

### US-040 — Start a Video Call (DM)
**As a** user,
**I want to** start a video call with the person I am direct messaging,
**So that** I can have a face-to-face conversation.

**Acceptance Criteria:**
- 📹 Call button in the topbar initiates the call
- A status-aware prompt warns if the other user is Offline or Busy
- Local camera and microphone are requested
- If camera permission is denied, audio-only call starts

---

### US-041 — Start a Video Call (Channel)
**As a** user,
**I want to** start a video call with any user in a channel,
**So that** I can call someone not in my DMs.

**Acceptance Criteria:**
- A call picker modal shows all users with their current status
- Offline users are dimmed; a confirmation is required before calling them

---

### US-042 — Answer an Incoming Call
**As a** user,
**I want to** see an incoming call notification and answer or decline it,
**So that** I can receive video calls from colleagues.

**Acceptance Criteria:**
- An incoming call banner appears at the top of the screen
- An audible ringtone plays on the callee's device
- ✅ Answer opens the call modal; ❌ Decline dismisses the banner
- The caller's device rings while waiting for an answer
- Ringtone stops as soon as the call is answered or declined

---

### US-043 — Mute Mic / Disable Camera
**As a** user in a video call,
**I want to** toggle my microphone or camera on and off,
**So that** I can control my own audio and video during the call.

**Acceptance Criteria:**
- 🎤 button mutes/unmutes; icon changes to 🔇 when muted; button turns red
- 📷 button enables/disables camera; icon changes to 🚫 when off; button turns red

---

### US-044 — End a Call
**As a** user,
**I want to** end a video call,
**So that** I can return to the chat.

**Acceptance Criteria:**
- 📵 End Call button closes the call modal
- Local media tracks are stopped
- Peer connection is closed
- Firestore call document is marked as "ended"

---

## Epic 10: Mobile Experience

### US-045 — Responsive Mobile Layout
**As a** mobile user,
**I want** the app to work well on my phone,
**So that** I can chat on the go without a degraded experience.

**Acceptance Criteria:**
- Sidebar is a full-screen drawer that slides in from the left
- A ✕ close button appears in the sidebar on mobile
- The topbar collapses: labels are hidden, icons remain
- Input bar is sticky to the bottom and accounts for the virtual keyboard
- Safe-area-inset padding is applied for notched devices (iOS)

---

### US-046 — Mobile Message Actions
**As a** mobile user,
**I want to** access message actions by long-pressing a message bubble,
**So that** right-click actions work on touch devices.

**Acceptance Criteria:**
- Holding a bubble for 700ms opens the floating action bar near the touch point
- Moving the finger more than 10px cancels the long-press (allowing scrolling)
- The action bar has larger 36×36px touch targets on mobile
- Tapping outside the bar closes it

---

### US-047 — New Line on Mobile
**As a** mobile user,
**I want** a dedicated button to insert a new line in my message,
**So that** I can write multiline messages without accidentally sending.

**Acceptance Criteria:**
- A ↵ new-line button is visible in the input bar on mobile only
- Enter always sends the message on mobile (no Shift+Enter behaviour)

---

## Epic 11: Offline Support (Planned / Partial)

### US-048 — Offline Message Cache
**As a** user,
**I want** previously loaded messages to be available even without a connection,
**So that** I can read recent conversations offline.

**Acceptance Criteria:**
- `OfflineStore` caches up to 200 messages per channel in localStorage
- Cached users and channels are persisted across sessions
- An outbox queue holds messages typed while offline for delivery when reconnected

---

## Appendix: Summary Table

| ID     | Epic               | Story                                  | Priority |
|--------|--------------------|----------------------------------------|----------|
| US-001 | Authentication     | Sign In                                | P0       |
| US-002 | Authentication     | Register                               | P0       |
| US-003 | Authentication     | Logout                                 | P0       |
| US-004 | Messaging          | Send a Message                         | P0       |
| US-005 | Messaging          | Send a Multiline Message               | P1       |
| US-006 | Messaging          | Send Emoji                             | P1       |
| US-007 | Messaging          | Attach Files                           | P1       |
| US-008 | Messaging          | Paste Image                            | P2       |
| US-009 | Messaging          | Drag and Drop Image                    | P2       |
| US-010 | Messaging          | Real-Time Message Updates              | P0       |
| US-011 | Messaging          | Clickable Links                        | P2       |
| US-012 | Message Actions    | Open Action Bar                        | P1       |
| US-013 | Message Actions    | Reply / Quote                          | P1       |
| US-014 | Message Actions    | React with Quick Emoji                 | P1       |
| US-015 | Message Actions    | React with Any Emoji                   | P2       |
| US-016 | Message Actions    | Translate a Message                    | P2       |
| US-017 | Message Actions    | Copy a Message                         | P2       |
| US-018 | Message Actions    | Edit Own Message                       | P1       |
| US-019 | Message Actions    | Delete a Message                       | P1       |
| US-020 | Message Actions    | Select and Copy Text                   | P2       |
| US-021 | Channels           | Create a Channel                       | P0       |
| US-022 | Channels           | Rename a Channel                       | P1       |
| US-023 | Channels           | Manage Participants                    | P1       |
| US-024 | Channels           | Delete a Channel                       | P1       |
| US-025 | Channels           | Filter / Search Sidebar                | P1       |
| US-026 | Direct Messages    | Start a Direct Message                 | P0       |
| US-027 | Direct Messages    | Sort DMs by Activity                   | P1       |
| US-028 | Direct Messages    | Rename a Contact                       | P2       |
| US-029 | Direct Messages    | Delete DM for Me                       | P2       |
| US-030 | Direct Messages    | Delete DM for Everyone                 | P2       |
| US-031 | Notifications      | Unread Badges                          | P0       |
| US-032 | Notifications      | Unread Tab Title and Favicon           | P1       |
| US-033 | Notifications      | Desktop Push Notifications             | P1       |
| US-034 | Notifications      | Mark as Read on Focus                  | P1       |
| US-035 | Notifications      | Seen Receipts                          | P1       |
| US-036 | Members            | View Members Panel                     | P1       |
| US-037 | Members            | Remove a User (Admin)                  | P2       |
| US-038 | Members            | Update Profile Settings                | P1       |
| US-039 | Search             | Search Within Conversation             | P2       |
| US-040 | Video Calls        | Start a Video Call (DM)                | P1       |
| US-041 | Video Calls        | Start a Video Call (Channel)           | P2       |
| US-042 | Video Calls        | Answer an Incoming Call                | P1       |
| US-043 | Video Calls        | Mute Mic / Disable Camera              | P1       |
| US-044 | Video Calls        | End a Call                             | P1       |
| US-045 | Mobile             | Responsive Mobile Layout               | P1       |
| US-046 | Mobile             | Mobile Message Actions                 | P1       |
| US-047 | Mobile             | New Line on Mobile                     | P2       |
| US-048 | Offline Support    | Offline Message Cache                  | P3       |
