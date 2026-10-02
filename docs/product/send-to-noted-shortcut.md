# Send to Noted: building the iOS Shortcut

Status: Recipe for the published Shortcut. The API it calls is implemented;
the Shortcut itself is assembled by hand on the iPad and published from there.
Plan: [`send-to-noted-shortcut-plan.md`](send-to-noted-shortcut-plan.md)

**Send to Noted** puts a PDF from Safari's PDF viewer or the Files app into
Noted from the Share sheet. If you already chose that IMSLP work in a Noted
draft, the PDF goes into that draft. Otherwise Noted starts a new draft, filling
in the title and composer when the file is an IMSLP download.

This page has two parts: setting the Shortcut up once (for each person), and
the action list for building and publishing it (once, by the maintainer).

## Setting it up on your iPad

1. In Noted, tap your name at the top of the library. The **Account** dialog
   opens.
2. Under **Send to Noted**, tap **Set up on this iPad**.
3. Tap **Install the Shortcut**. Shortcuts opens and asks three questions:
   - **Your Noted token**: go back to Noted, tap **Copy**, and paste it here.
   - **Noted address**: leave `https://noted.bitofbytes.io` as it is.
   - **Open Noted after sending**: leave `Yes`, or type `No` if you only want
     the notification.
4. Tap **Add Shortcut**, then close the Account dialog in Noted.

Noted shows the token only once. If you lose it, open the Account dialog, tap
**Replace**, and install the Shortcut again with the new token. **Turn off**
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
| Clair de lune — Debussy, Claude | Added to the waiting draft. |
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

## Building and publishing the Shortcut

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

The API also returns `title`, `composer`, `matched`, `draftId` and `filename`.
The Shortcut doesn't need them: `headline` and `message` are the notification,
already written by Noted.

### Import questions

In the shortcut's details, open **Setup** (on older iOS versions:
**⋯ → Import Questions**) and add three questions, each tied to one **Text**
action above:

| Action | Question | Default answer |
| --- | --- | --- |
| Step 2 (`paste-your-token-here`) | `Your Noted token` | leave empty |
| Step 4 (`https://noted.bitofbytes.io`) | `Noted address` | `https://noted.bitofbytes.io` |
| Step 6 (`Yes`) | `Open Noted after sending (Yes or No)` | `Yes` |

The token question must have an empty default, so the published Shortcut
carries nobody's token. Before sharing, check that the step 2 Text in your own
copy is still the placeholder, or set it back to `paste-your-token-here`.

### Checks before publishing

Run these on the iPad with your own token. They need a real device, so the
automated tests can't do them.

1. Share an IMSLP download (filename starting `IMSLP`, then digits and `-`)
   from Safari's PDF viewer while a Noted draft is waiting for that work.
   Expect "Added to the waiting draft." and the draft opening on its Pages
   step with the PDF.
2. Share the same work's PDF again. Expect "New draft created." with the title
   and composer filled in.
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

### Publishing

An iCloud link is a snapshot of the Shortcut at the time it was shared.
After any edit, share it again, copy the new link, and update
`SHORTCUT_INSTALL_URL`; the old link keeps installing the old version.

1. In Shortcuts, long-press **Send to Noted** → **Share** → **Copy iCloud
   Link**. The link starts `https://www.icloud.com/shortcuts/`.
2. Set `SHORTCUT_INSTALL_URL` to that link in the API's configuration and
   redeploy. Until then, the Account dialog says "The Shortcut link will be
   added here." and everything else works.
3. If you change the Shortcut later, publish it again and update
   `SHORTCUT_INSTALL_URL`. Installed copies keep working, because the API
   does not change.

## What the token can do

The token opens one thing: `POST /api/shortcut/import`, which creates or fills
a draft for its owner. It cannot read, list, finish or delete pieces or drafts,
and Noted's other pages and routes don't accept it. Noted stores only a hash of
the token, never the token itself. Each person has at most one token. Replace
and Turn off take effect immediately.
