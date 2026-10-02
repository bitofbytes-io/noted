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

1. **Receive** `PDFs` input from `Share Sheet`.
   - Tap the input type and leave only **PDFs** selected.
   - **If there's no input**: `Stop and Respond`.
2. **Text**: `paste-your-token-here`
3. **Set Variable** `Token` to the **Text** above.
4. **Text**: `https://noted.bitofbytes.io`
5. **Set Variable** `Noted` to the **Text** above.
6. **Text**: `Yes`
7. **Set Variable** `Open after sending` to the **Text** above.
8. **Repeat with Each** item in `Shortcut Input`. Inside the repeat:
   1. **Get Contents of URL**
      - URL: `Noted` variable, then type `/api/shortcut/import`
        (no space between them).
      - Tap **Show More**.
      - Method: `POST`.
      - Headers: add one. Key `Authorization`; value: type `Bearer` and a
        space, then the `Token` variable.
      - Request Body: `Form`. Add a field, choose **File**, key `file`,
        value `Repeat Item`.
   2. **If** `Contents of URL` **does not have any value**:
      - **Show Notification**: title `Noted`, body `Noted isn't reachable.`
      - **Stop This Shortcut**.
   3. **End If**.
   4. **Get Dictionary Value**: `Value` for key `error` in `Contents of URL`.
      **Set Variable** `Error` to it.
   5. **If** `Error` **has any value**:
      - **Show Notification**: title `Noted`, body the `Error` variable.
   6. **Otherwise**:
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
   7. **End If**.
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
