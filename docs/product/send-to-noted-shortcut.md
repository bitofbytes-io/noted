# Send to Noted: building the iOS Shortcut

Status: Recipe for the Shortcut and its template. The API it calls is
implemented. The Shortcut is assembled by hand on the iPad; Noted serves a
signed template of it, with a placeholder token, at `/send-to-noted.shortcut`.
Plans: [`send-to-noted-shortcut-plan.md`](send-to-noted-shortcut-plan.md),
amended by [`send-to-noted-simplifications-plan.md`](send-to-noted-simplifications-plan.md)

**Send to Noted** puts a PDF from Safari's PDF viewer or the Files app into
Noted from the Share sheet. Each PDF starts a new draft, with the title and
composer filled in when the file is an IMSLP download. (If you started in
Noted's IMSLP search, use **Add downloaded PDF** on that draft instead.)

This page has two parts: setting the Shortcut up once (for each person), and
the action list for building it and regenerating the template (by the
maintainer).

## Setting it up on your iPad

1. In Noted, tap your name at the top of the library. The **Account** dialog
   opens.
2. Under **Send to Noted**, tap **Set up on this iPad**.
3. Tap **Get the Shortcut**. Safari downloads `Send to Noted.shortcut`; open
   it from Safari's downloads (or Files → Downloads). Shortcuts shows the
   actions; tap **Add Shortcut**.
4. In Noted tap **Copy**. In Shortcuts open **Send to Noted** and paste the
   token over `paste-your-token-here` in the first text box. The next two
   text boxes are the Noted address (leave it) and `Yes` for opening Noted
   after sending (type `No` if you only want the notification). Tap Done.

The template has no import questions on purpose: Shortcuts' install-time
questions hang on current iOS (tapping Add Shortcut after answering does
nothing), so the token is pasted into the action instead.

Noted shows the token only once. If you lose it, open the Account dialog, tap
**Replace**, and install the Shortcut again with the new token. To add the
Shortcut to a second device, use **Get the Shortcut again** in the Account
dialog; you need your token for it, so if you don't have it, tap **Replace**
and paste the new token on both devices. **Turn off**
stops the Shortcut from sending anything. Signing out of Noted does not affect
the Shortcut.

## Sending a score

On IMSLP, open the download so Safari shows the PDF. Tap **Share**, then
**Send to Noted**. You can also share any PDF from the Files app.

If the notification says the draft is called "PDF document" and its pages are
blank, Safari shared the page rather than the file and the Shortcut printed it.
The Shortcut must accept URLs and download the file (step 8.1 below). Until
then, save the PDF to Files first and share it from there.

When it works, you see a notification like one of these, and then Noted opens
the draft (unless you answered `No` above):

| Notification title | Text |
| --- | --- |
| Quasi valse, Op.47 — Scriabin, Aleksandr | New draft created. |
| Bach - Prelude in C | New draft created. |

The last row is a PDF that is not an IMSLP download, so its title is the
filename. You can change it on the Details step.

When something goes wrong, the notification is titled **Noted** and says why:

| Text | What happened |
| --- | --- |
| This shortcut was turned off. Set it up again in Noted. | The token was replaced or turned off, or was pasted wrongly. |
| Only PDF files can be sent. | The shared file is not a PDF. |
| File is larger than Noted allows. | The PDF is over the upload limit (50 MB unless the server is set differently). |
| You have 20 open drafts. Finish or delete one in Noted, then send again. | The draft limit is reached. |
| Too many files sent in a minute. Wait a moment and send again. | More than 10 files in one minute. |
| Noted couldn't store the file. Try again later. | The server could not save the file. |
| Noted isn't reachable. | Noted gave no answer. |

If the iPad has no connection at all, iOS may stop the Shortcut with its own
alert (for example "The request timed out") before the last row can appear.

## Building the Shortcut and its template

Build it on the iPad in the Shortcuts app. Text in **bold** is the exact
action name to search for; `code` is text to type. Variables are made with
**Set Variable** so later actions can refer to them by name.

### Details

In the shortcut's details (the ⓘ button at the bottom of the editor):

- Name: `Send to Noted`. Pick any icon.
- **Show in Share Sheet**: on.
- **Show in Quick Actions** (Mac): off.

### Actions

1. **Receive** `PDFs` and `URLs` input from `Share Sheet`.
   - Tap the input type and leave **only PDFs and URLs** selected. Safari's
     built-in PDF viewer does not share the file: it shares the page's URL.
     With **Apps** or **Safari web pages** selected instead, Shortcuts
     converts the page by printing it, and Noted receives a small file named
     "PDF document" with blank pages. Accepting URLs lets the Shortcut
     download the real file itself (step 8.1); the Files app still shares
     PDFs directly.
   - **If there's no input**: `Stop and Respond`.
2. **Text**: `paste-your-token-here`
3. **Set Variable** `Token` to the **Text** above.
4. **Text**: `https://noted.bitofbytes.io`
5. **Set Variable** `Noted` to the **Text** above.
6. **Text**: `Yes`
7. **Set Variable** `Open after sending` to the **Text** above.
8. **Repeat with Each** item in `Shortcut Input`. Inside the repeat:
   1. Turn a shared link into the file:
      - **Get URLs from** `Repeat Item`.
      - **Set Variable** `Link` to `URLs`. Use `Link` below rather than the
        magic variable: the editor shows several different outputs as a bare
        "URL", and picking the wrong one silently takes the Otherwise branch.
      - **If** `Link` **has any value** (Safari shared a link):
        - **Get Contents of URL**: `Link`, method `GET`, nothing else
          changed. This downloads the PDF on the iPad.
        - **Get Component of URL**: `Path` of `Link`; **Split Text** by `/`;
          **Get Item from List**: `Last Item`. This is the IMSLP filename.
        - **Set Name** of the downloaded *Contents of URL* to that item, with
          **Don't Include File Extension** off.
        - **Set Variable** `File` to the renamed file.
      - **Otherwise** (Files shared a PDF): **Set Variable** `File` to
        `Repeat Item`.
      - **End If**.
   2. **URL**: the `Noted` variable, then type `/api/shortcut/import`
      directly after it (no space). A separate **URL** action is required:
      putting the variable straight into *Get Contents of URL* fails with
      "couldn't convert from Rich Text to URL".
   3. **Get Contents of URL**, with the **URL** from the action above.
      - Tap **Show More**.
      - Method: `POST`.
      - Headers: add one. Key `Authorization`; value: type `Bearer` and a
        space, then the `Token` variable.
      - Request Body: `Form`. Add a field, choose **File**, key `file`,
        value the `File` variable. The key is the plain text `file`; the
        variable goes in the value slot (it says *Choose* until set). A
        variable dropped into the key leaves the value empty, and Noted
        answers "Send the PDF as the form field named file.".
   4. **If** `Contents of URL` **does not have any value**:
      - **Show Notification**: title `Noted`, body `Noted isn't reachable.`
      - **Stop This Shortcut**.
   5. **End If**.
   6. **Get Dictionary Value**: `Value` for key `error` in `Contents of URL`.
      **Set Variable** `Error` to it.
   7. **If** `Error` **has any value**:
      - **Show Notification**: title `Noted`, body the `Error` variable.
   8. **Otherwise**:
      - **Get Dictionary Value** `headline` in `Contents of URL`;
        **Set Variable** `Headline`.
      - **Get Dictionary Value** `message` in `Contents of URL`;
        **Set Variable** `Message`.
      - **Get Dictionary Value** `draftPath` in `Contents of URL`;
        **Set Variable** `Draft path`.
      - **Show Notification**: title the `Headline` variable, body the
        `Message` variable.
      - **If** `Open after sending` **is** `Yes`:
        - **URL**: the `Noted` variable followed by the `Draft path`
          variable (no space).
        - **Open URLs**.
      - **End If**.
   9. **End If**.
9. **End Repeat**.

The API also returns `title`, `composer`, `draftId` and `filename`.
The Shortcut doesn't need them: `headline` and `message` are the notification,
already written by Noted.

### Import questions

The template asks three questions on install, each tied to one **Text**
action above. They are added to the template file when it is regenerated (see
below); in the plist they are the `WFWorkflowImportQuestions` entries for
action indices 0, 2 and 4, because **Receive** is a workflow setting rather
than an action.

| Action | Question | Default answer |
| --- | --- | --- |
| Step 2 (`paste-your-token-here`) | `Your Noted token` | leave empty |
| Step 4 (`https://noted.bitofbytes.io`) | `Noted address` | `https://noted.bitofbytes.io` |
| Step 6 (`Yes`) | `Open Noted after sending (Yes or No)` | `Yes` |

The token question must have an empty default, so the template carries
nobody's token.

**Never share your own copy of the Shortcut by iCloud link.** An iCloud link is
a snapshot of the Shortcut's actions, including the Text action holding your
token: anyone who installs it can send files into your Noted. Give people the
Account dialog's **Get the Shortcut** link instead. If a personal link was
shared, tap **Replace** in Noted.

### Checks after regenerating the template

Run these on the iPad with your own token. They need a real device, so the
automated tests can't do them.

1. In Noted's Account dialog, tap **Get the Shortcut** (or **Get the Shortcut
   again**). Expect Shortcuts to open the template's Add Shortcut screen and
   ask the three questions above; paste your token.
2. Share an IMSLP download (filename starting `IMSLP`, then digits and `-`)
   from Safari's PDF viewer. Expect "New draft created." with the title and
   composer filled in, and the draft opening on its Pages step with the PDF.
   Share it again: expect a second new draft.
3. Share a PDF from Files that is not from IMSLP. Expect a new draft titled from
   the filename.
4. Share a photo or other non-PDF from Files: the Shortcut shouldn't be offered.
   If it is, expect "Only PDF files can be sent."
5. In Noted, tap **Replace**, then share again with the old Shortcut. Expect
   "This shortcut was turned off. Set it up again in Noted."
6. Check that Safari's Share sheet passes the PDF with its IMSLP filename. If a
   Safari share arrives without the `IMSLP<number>-` prefix, it lands as a new
   draft titled from whatever name Safari gave it. Sharing from Files after
   downloading keeps the name.

### Regenerating the template

Noted serves `web/public/send-to-noted.shortcut` as `/send-to-noted.shortcut`.
It is a signed copy of the Shortcut above with the placeholder token. Since iOS
15 a `.shortcut` file imports only when signed. Regenerate it after any change
to the actions, on a Mac signed in to the same iCloud account:

1. In Shortcuts, duplicate **Send to Noted**. In the duplicate, set step 2's
   **Text** back to `paste-your-token-here`. The duplicate's name does not
   matter: the installed Shortcut takes its name from the served file name,
   `Send to Noted.shortcut`.
2. Get the duplicate's unsigned plist, either way:
   - On the Mac, once the duplicate has synced: **File → Export**.
   - From iCloud: share **the duplicate only** (it holds no token) with
     **Copy iCloud Link**, take the ID after `/shortcuts/`, and fetch
     `https://www.icloud.com/shortcuts/api/records/<id>`. Its
     `fields.shortcut.value.downloadURL` is the unsigned plist; download it
     as `template.shortcut`.
3. Check it holds the placeholder and no token:
   `plutil -p template.shortcut | grep -n paste-your-token-here`, and that
   `WFWorkflowImportQuestions` is empty (do not add any; they hang on
   install).
4. Sign it for anyone and replace the committed file:

   ```sh
   shortcuts sign --mode anyone --input template.shortcut \
     --output web/public/send-to-noted.shortcut
   ```

5. Commit the signed file (it contains no secret), deploy the UI, and run the
   checks above. Installed copies keep working; only new installs get the new
   version. Delete the duplicate in Shortcuts.

The UI container serves the file with `Content-Type: application/octet-stream`
(iOS goes by the `.shortcut` extension; there is no registered MIME type) and
`Content-Disposition: attachment; filename="Send to Noted.shortcut"`.
`make test-ui-container-mime` checks both.

## What the token can do

The token opens one thing: `POST /api/shortcut/import`, which creates a new
draft for its owner. It cannot read, list, finish or delete pieces or drafts,
and Noted's other pages and routes don't accept it. Noted stores only a hash of
the token, never the token itself. Each person has at most one token. Replace
and Turn off take effect immediately.
