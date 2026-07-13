# Noted: Product Discovery Brief

Status: Historical discovery record; see `poc-requirements.md` for implementation scope
Last updated: 2026-07-13

## Current product thesis

The first useful version of Noted should make it easy to **find, catalog, open, and play back piano music**. Assignments, favorites, personal notes, and lightweight practice tracking should organize the user's activity around that music rather than compete with the score-library experience.

The initial household contains two learners—the creator and his son—who need separate progress and personal notes but may benefit from a shared family music library.

The musical work—not a particular edition—is the learner-facing identity. Editions and score files are alternative sources or representations of the same music. A learner's practice history and progress should roll up to the work while retaining optional references to the exact score and passage used.

## Working concept

Noted is a personal piano learning and sheet-music web application. It brings together three experiences that are currently fragmented across physical music books, loose sheet music, lesson notes, music-library tools, and music-theory training sites:

1. A personal repertoire and sheet-music collection.
2. A structured piano practice and lesson workspace.
3. Interactive music-theory learning and training.

The product is inspired by the organization and collection experience of Anthology, the physical and musical interaction of a piano, and the focused learning exercises of musictheory.net. The ambition is eventually broader than a simple sheet-music catalog or practice tracker.

## Problem statement

A piano learner may accumulate music across books, PDFs, websites, teachers, and handwritten lesson notes. It becomes difficult to answer basic questions:

- What music do I own or have access to?
- What have I played, and what did I enjoy?
- What am I currently learning?
- What did my teacher ask me to practice?
- Which passages need focused work?
- What should I learn next at my current ability level?
- Where can I find a legal, free edition of a classical work?
- How does the theory I am learning connect to the music I am playing?

Noted should provide one durable home for those answers.

## Early product areas

### Library and discovery

- Search for music, initially emphasizing legal, free, public-domain classical repertoire.
- Save pieces and editions to a personal collection.
- Record music owned in physical books as well as digital sheet music.
- Favorite, organize, and revisit pieces.
- Track pieces that a user wants to learn, is learning, has learned, or has archived.
- Support multiple persistent user accounts, including separate accounts for family members.

### Practice and lessons

- Track current pieces, assignments, goals, and lesson history.
- Record practice activity and progress.
- Work on a specific movement, page, measure range, hand, or musical concern.
- Save practice loops and playback settings for difficult passages.
- Preserve teacher notes or personal annotations.

### Sheet-music workspace

- Display sheet music comfortably on an iPad and desktop browser.
- Play a score using synthesized or MIDI-style playback when structured score data is available.
- Change tempo/BPM.
- Choose a playback start and end point.
- Loop a selected section.
- Navigate and interact with a score while seated at a piano.

### Learning and training

- Provide a distinct learning interface for music theory and musicianship.
- Offer lessons and interactive exercises.
- Eventually connect exercises to the repertoire a learner is studying.
- Potential topics include notation, rhythm, intervals, scales, key signatures, chords, harmony, ear training, and keyboard geography.

## Users

The initial users are the creator and his son. The architecture should allow separate identities, collections, progress, and preferences. Google-based OAuth is the leading sign-in approach, modeled loosely on Anthology's persistent account experience.

Future user types are intentionally undecided. Possibilities include independent learners, parents, teachers, and students.

The music teacher is not expected to use the initial product. Learners will record assignments and teacher feedback themselves. Direct teacher participation is a possible later expansion.

## Current real-world workflow

1. Piano lessons happen in person.
2. The teacher assigns pieces and exercises from physical music books or printouts.
3. Assignments and score PDFs may be sent by email.
4. Practice during the week is driven primarily by those assignments.
5. Most repertoire is public-domain classical music, sourced from books, PDFs, printouts, and sites believed to include IMSLP.
6. There is currently no unified place to keep the playable score, assignment, teacher feedback, practice notes, and personal history together.

## Confirmed user needs from discovery

- Search for public-domain classical repertoire.
- Catalog music from physical books and downloaded PDFs.
- Pull up scores currently being practiced.
- Play back music when a playback-capable representation is available.
- Favorite pieces.
- Track practice.
- Record lesson assignments and exercises.
- Attach free-form notes and teacher feedback.
- Point instructions at specific measures.
- Record target tempos.
- Record due dates and the next lesson date.
- Keep personal notes and progress separate for each learner.
- Consider a shared family music library with individual activity layered on top.
- Let users both search a public catalog and upload their own score files.
- Associate a musical work with multiple editions rather than collapsing them into one score.
- Store complete digital copies where legally permissible and allow personal scans where legally appropriate.
- Support score annotations, including personal fingering changes.
- Provide playback for preview, learning notes and rhythm, slower practice, and accompaniment.
- Include tempo control, measure selection, loops, count-in, metronome, and hand/part isolation in the long-term playback experience.
- Use tap, swipe, and playback-following navigation initially; consider Bluetooth page-turn pedals later.
- Optimize initially for a 13-inch iPad used in portrait orientation.
- Use separate Google identities for each learner.
- Provide Apple Pencil freehand annotation as the initial markup tool.
- Keep each learner's annotations private by default while allowing intentional sharing.
- Allow users to review and correct notation-recognition results before enabling trusted playback.
- Use an industry-standard, preferably open, structured notation format.
- Let users toggle between or show/hide the original score and a recognized playable representation.
- Import selected public scores into the user's local Noted library rather than treating external search results as permanent library entries.

## Deferred opportunities

- Teacher accounts and direct assignment workflows.
- Additional guided lessons based on current level and practiced repertoire.
- Adaptive recommendations or teaching plans.
- Rich score markup and annotations beyond the simplest viable notes.
- Advanced family administration and sharing rules.

## Experience model under consideration

The product may have two primary modes:

1. **Play / Library**: discover, collect, view, hear, and practice music.
2. **Learn / Train**: study concepts and complete interactive exercises.

Practice and lesson tracking may become a third primary area or may serve as the connective layer between the two modes.

## Technical direction under consideration

- Web application optimized for desktop and iPad use.
- Angular frontend.
- Go backend.
- Separate frontend and backend applications, following a setup similar to Anthology.
- Persistent user accounts and Google OAuth.

These are current preferences, not permanent requirements. Important architectural questions remain around score formats, rendering, playback, storage, offline use, search sources, and copyright boundaries.

## Product principles to test

- **At the piano first:** common actions should require very few taps and work at music-stand distance.
- **One musical identity:** repertoire, practice, lessons, and theory progress should reinforce each other.
- **Respect the score:** the sheet music remains central rather than becoming decoration around tracking features.
- **Progress without pressure:** tracking should help reflection and consistency without turning music into an obligation.
- **Source-aware and legal:** distinguish works, editions, files, and rights status rather than treating every PDF as interchangeable.
- **Useful before complete:** the first release should solve a meaningful personal workflow even before advanced playback or training features exist.

## Important distinctions

- A **work** (for example, a Beethoven sonata) is not the same as an **edition**, score file, movement, or personally owned book.
- A public-domain **composition** does not guarantee that a particular modern engraving, recording, or download is public domain.
- PDF scores can be displayed and annotated, but reliable note-level playback and measure-aware interaction usually require structured formats such as MusicXML or MEI.
- Separate family accounts do not necessarily imply child-account administration, parental controls, or teacher/student sharing; those are open decisions.
- A responsive website does not necessarily provide robust offline use on an iPad; offline behavior must be designed explicitly if needed.
- Converting a printed or PDF score into playable notation is an optical music recognition (OMR) task. OMR can accelerate entry but is not reliably error-free, especially with scans, unusual engraving, fingerings, handwritten marks, or complex piano notation.
- MIDI represents performance-oriented musical events but does not preserve all details needed for faithful printed notation. MusicXML or MEI is a better canonical source for notation-aware playback and editing, with MIDI generated for playback when useful.
- An annotation overlay should be stored separately from the underlying score so that personal fingerings and notes do not permanently alter a shared edition.

## Emerging music data model

- **Work:** the abstract composition, such as a sonata, prelude, or étude.
- **Part or movement:** a navigable subdivision of a work.
- **Edition:** a particular engraving, arrangement, revision, or publication of the work.
- **Score asset:** a PDF, scan, MusicXML file, MEI file, or other digital representation belonging to an edition.
- **Physical copy:** a user's book or printout, including location and page information.
- **Library entry:** a household's saved relationship to a work or edition.
- **User repertoire entry:** one learner's status, favorite state, rating, and history for that music.
- **Annotation layer:** one learner's marks, fingerings, measure notes, and other overlays attached to a specific score asset.
- **Practice target:** a movement, page, measure range, hand/part, tempo goal, and related instructions.
- **Practice session:** a small set of common searchable fields plus free-form notes, allowing useful history without forcing every observation into a rigid template.
- **Shared annotation copy or layer:** an explicitly shared annotation artifact that does not erase the recipient's independent annotations.
- **Book edition:** an identified physical publication, preferably associated with an ISBN and a table of contents.
- **Book holding:** a household's ownership of a book edition.
- **Book contents entry:** a relationship between a book edition, page range, and a known work or edition, with confidence and provenance when matched automatically.
- **Learner-work relationship:** the central user-specific record connecting a learner to a work, including status, favorites, tags, assignments, annotations, notes, and practice history. A work need not appear in a learner's active repertoire until this relationship exists with an active status.
- **Passage reference:** an optional location within a work or score, such as movement, page, measure range, hand/part, and BPM. Practice records and assignments may use passage references without making the edition the learner's primary identity.

## Emerging score ingestion workflow

1. Search public repertoire sources, initially with IMSLP as an important candidate.
2. Choose a work and, where applicable, a specific edition.
3. Import an allowed score asset into the user's private Noted library.
4. Preserve the source, attribution, rights information, original file, and edition relationship.
5. Display the original PDF immediately.
6. If playable structured notation is unavailable, optionally run optical music recognition.
7. Let the user review and correct recognition results using an established notation representation and compatible tooling.
8. Generate playback from the reviewed structured score.
9. Allow the original and recognized views to be shown or hidden as needed.
10. Store private Apple Pencil annotations as a separate layer, with deliberate sharing available later.

The availability and permitted mechanics of IMSLP search, download, caching, and redistribution require a dedicated legal and technical research step. No integration method is assumed yet.

## Emerging physical-book workflow

1. Add a physical book by scanning or entering its ISBN when available.
2. Retrieve bibliographic metadata and a table of contents when a suitable source provides them.
3. If contents are unavailable, photograph/scan the contents pages or enter pieces manually.
4. Match each contents entry to an existing work in Noted, retaining a confidence level and allowing correction.
5. Make matched works searchable as “available in my books,” even when Noted has no digital score.
6. When the learner begins a piece, attach a public score, scan the relevant pages where legally appropriate, or record the physical page location.

An ISBN identifies a particular book edition but does not guarantee that machine-readable contents are available. Contents discovery must therefore be best-effort and correction-friendly.

## Emerging navigation model

Noted is one application with two primary modes:

- **Play:** search, collect, open, annotate, hear, practice, and enjoy repertoire.
- **Learn:** follow theory and musicianship material, exercises, and eventually guided recommendations.

Assignments and practice connect the two modes. A learner may practice music because it was assigned, because it supports a learning goal, or simply because they enjoy playing it.

## Confirmed product sequence

1. **Store and Play:** search/import public scores, organize repertoire, view scores, and play structured scores.
2. **Track:** practice timers/manual logs, weekly metrics, calendar, lessons, assignments, and progress summaries.
3. **Annotate:** private Apple Pencil markup over score assets.
4. **Learn:** built-in lessons, curated external learning references, music theory, and eventually repertoire-aware guidance.

The first three product priorities are:

- Keep/find pieces and play them back.
- Track practice and show weekly progress.
- Annotate scores.

## Candidate scope layers

### Foundation

- Authentication and separate accounts.
- Personal repertoire catalog.
- Piece status, favorites, and basic organization.
- Lesson and practice notes.
- iPad-friendly score viewing.

### Rich practice workspace

- Measure-aware navigation.
- Tempo-controlled playback.
- Section loops and saved practice targets.
- Annotations and progress history.

### Learning system

- Theory lessons and exercises.
- Adaptive or structured learning paths.
- Ear and rhythm training.
- Links between concepts and repertoire.

### Ecosystem possibilities

- Teacher/student workflows.
- Family sharing.
- Community metadata or recommendations.
- Imports from score libraries and catalogs.
- MIDI keyboard input and performance feedback.

No scope layer is yet approved as a release plan.

## Preliminary version-one shape

This is a discovery hypothesis, not an approved specification.

### Core

- Google sign-in and separate learner profiles.
- A potentially shared household catalog with user-specific favorites, status, assignments, notes, and practice history.
- Catalog records for works, editions/files, and physical-book locations.
- Search and discovery focused on public-domain classical music.
- PDF upload and score viewing.
- Structured-score viewing and synthesized playback where MusicXML or another supported notation format is available.
- Piece states such as assigned, learning, playable, and previously played.
- Lesson records containing assigned pieces, exercises, notes, teacher feedback, measure references, tempo targets, and dates.
- Lightweight practice logging.
- An iPad-first score-reading experience.

### Explicitly not assumed for version one

- Teacher login.
- Automatic generation of a personalized curriculum.
- Full notation editing.
- Reliable playback extracted automatically from arbitrary PDFs.
- Collaborative real-time annotations.
- Social or community features.
- MIDI-keyboard listening or automated evaluation of the learner's performance.
- Offline practice support.
- Bluetooth pedal integration.
- Perfect automatic conversion of arbitrary PDFs or scans into playable notation.
- Typed annotation, semantic fingering tools, highlighting, and a large palette of musical markup symbols.
- Automatic restoration of every per-score view and playback setting; this is desirable but not initially mandatory.

## Discovery questions

The open questions will be answered in rounds so that early answers can shape later, more detailed questions.

### Round 1: product center and real-world workflow

1. If Noted could solve only one problem exceptionally well in its first useful version, which problem should it solve?
2. Walk through your current piano workflow from receiving an assignment to practicing during the week and returning to the next lesson. Where does information live at each step?
3. What does Anthology do particularly well that you want to preserve? Which parts of its experience should Noted avoid?
4. When you say you want to track lessons, do you imagine writing free-form notes, recording assignments, scheduling lessons, attaching media, tracking teacher feedback, or all of these?
5. Do you currently work with a teacher? If so, would the teacher eventually use Noted directly, or would you initially enter the teacher's assignments yourself?
6. What forms is your existing music in: physical books, PDFs, scans, MusicXML, MIDI, links, apps, or something else?
7. For a physical book, what should saving it in Noted accomplish if the score itself is not digitized?
8. When you say music you “can play,” what states or levels matter to you? For example: sight-read, learning, playable slowly, performance-ready, memorized, or previously learned.
9. At the piano, what are the three most common things you would want to do on the iPad with wet hands metaphorically speaking—meaning quickly, without fiddling with controls?
10. Is internet-free practice important, or can the first version assume a reliable connection?
11. Should your son's account be entirely independent, linked under a family, or managed by you? How old is he, approximately, since that affects privacy and child-account design?
12. Is this primarily a private tool for your family at first, or do you want early architectural decisions to assume a public product with many users?
13. Which part excites you most: building a beautiful music library, creating the best practice companion, or making theory learning connect to real repertoire?
14. What would make you personally use Noted three times a week six months after launch?

### Round 1 answers received

- The first-version center is searching, cataloging, and playing back music.
- Current assignments originate with an in-person teacher and arrive through physical books, printouts, and emailed PDFs.
- Practice is guided by the teacher's assignment.
- Most repertoire is public-domain classical music.
- Anthology's relevant strength is centralized cataloging; Noted should go further by surfacing scores, favorites, and practice activity.
- The existing collection consists primarily of physical books and downloaded PDFs, with many scores believed to come from IMSLP.
- Lesson tracking should include free-form notes, assigned pieces and exercises, measure-specific instructions, tempo targets, due dates, next-lesson dates, and teacher feedback.
- The teacher will not initially have an account.
- The creator and his son will use separate accounts. Sharing music may be useful, while each user should retain personal notes.
- Score markup is desirable but may be deferred.
- Guided practice or lessons tailored to ability and repertoire are a later-version opportunity.

### Round 2: library, score, and playback decisions

1. Should users find a piece in Noted's public catalog and add it instantly, upload their own file, or do both?
2. When several editions of the same piece exist, should Noted show them separately and let the user choose an edition, or try to present one recommended score by default?
3. For physical books, is a searchable record with book title and page number enough, or would you want to photograph/scan pages into Noted?
4. Are emailed assignment PDFs normally complete scores, individual pages, or teacher-created worksheets? Would manually uploading them be acceptable initially?
5. Is PDF display alone useful even when playback and measure-aware controls are unavailable?
6. For playback, is the main purpose previewing unfamiliar music, hearing rhythm and notes while learning, or playing along with accompaniment?
7. During playback, which controls are essential: tempo, play/pause, measure selection, looping, count-in, metronome, instrument sound, hand/part isolation, or note highlighting?
8. Would you use a connected digital piano or MIDI keyboard with Noted? If yes, what model or connection method do you currently use?
9. Should the first release work without internet during practice, or can offline scores be a later enhancement?
10. Do you normally place the iPad in landscape or portrait orientation at the piano? What iPad size do you use?
11. Should page turns happen by tapping/swiping, an on-screen gesture, a Bluetooth pedal, automatic playback position, or some combination?
12. Would each person have a separate Google login, or should one parent Google account contain multiple learner profiles?
13. When music is shared, should both learners see the same uploaded score while retaining separate favorites, assignments, notes, tempos, and practice histories?
14. What practice history would feel helpful rather than burdensome: a timer, manual session entry, a simple practiced-today check, measure/tempo progress, or all of these?

### Round 2 answers received

- Users should be able to search Noted's catalog and upload their own files.
- A work may reference multiple editions.
- Full digital copies are desirable where permissible; users may also scan music from their books where legally appropriate.
- The desired experience combines viewing, playback, and a personal annotation overlay. Fingering changes are a common annotation need.
- Playback should support previewing, learning notes and rhythm, slower play-along practice, and accompaniment.
- Desired playback controls include tempo, measure-range selection, looping, count-in, metronome, and left/right hand or part isolation. Note highlighting and instrument selection are not priorities.
- Practice will normally use an acoustic piano. Digital-piano input and automated listening are not part of the first version; the learner will compare by ear.
- Offline operation is not required initially.
- The primary device is a 13-inch iPad in portrait orientation.
- Initial page navigation may use tapping, swiping, or movement during playback. Bluetooth pedal support can come later.
- Each learner will use a separate Google account.
- Practice tracking will likely combine several lightweight mechanisms; the exact interaction remains open.

### Round 3: annotation, ingestion, organization, and practice

1. Should annotations be private by default, or should a learner be able to share selected fingering and notes with another family member?
2. Which annotation tools matter most: freehand pencil, typed text, fingering numbers, highlighting, musical symbols, measure comments, or bookmarks?
3. Do you use an Apple Pencil, and should writing with it feel like marking paper?
4. Should annotations remain attached to exact positions on a PDF page, or should structured scores attach notes to measures and musical events when possible?
5. If Noted attempts to recognize a PDF or scan, would you accept a review/correction step before playback is enabled?
6. Should Noted preserve the original PDF alongside any recognized MusicXML version so the user can compare them?
7. Would you manually enter or correct notes in a notation editor, or should the product avoid full score editing initially?
8. How would you prefer to browse the catalog: composer, title, period, form, key, difficulty, favorites, recently practiced, books, or custom collections?
9. Should Noted recommend a difficulty level automatically, let users rate difficulty personally, use published grading systems, or combine these?
10. What repertoire states should exist? A starting proposal is: interested, assigned, learning, playable, polished, memorized, paused, and archived.
11. Should a single assignment contain several practice targets, such as “measures 1–8 hands separately at 60 BPM” and “measures 9–16 together at 50 BPM”?
12. When you finish practicing, what is the smallest useful record: elapsed time, piece, measure range, achieved tempo, a note, perceived quality, or simply completion?
13. Would you want Noted to remember playback and page position automatically for each piece?
14. Should uploaded PDFs be added to the shared family library automatically, or remain private unless explicitly shared?

### Round 3 answers received

- Initial annotation can be limited to Apple Pencil/freehand markup.
- Each learner should have independent, private annotations that may be shared deliberately.
- Score recognition requires a review/correction step because conversion errors are expected.
- Recognition and correction should use an industry-standard or open format and compatible tooling.
- The original score should be available through a show/hide or view toggle.
- Browsing should support composer, title, period, form, key, difficulty, favorites, recent activity, current repertoire, physical books, and custom collections.
- Difficulty should combine available published grades with Noted and personal assessments.
- The proposed repertoire states are a good starting point: interested, assigned, learning, playable, polished, memorized, paused, and archived.
- An assignment may contain several detailed practice targets.
- Practice records should combine common fields with flexible free-form notes.
- Remembering score and playback state is desirable but not a hard initial requirement.
- User uploads are private until explicitly shared.
- Public discovery should search IMSLP and potentially other sources, after which selected music is imported into the user's Noted library.

### Round 4: search, practice records, sharing, and experience boundaries

1. When searching for a composition, should results lead with the work and then show editions, or show every downloadable score directly in the results?
2. Should search include pieces that Noted knows about but cannot currently provide as a legal downloadable score?
3. What source information should remain visible after import: source site, uploader, editor, publisher, scan date, license/rights status, and original URL?
4. If an IMSLP or external file changes or disappears, should Noted keep the imported copy when permitted?
5. Should users be able to upload a PDF directly from email, Files, Google Drive, or all of these on the iPad?
6. Which common practice fields should be present by default? A proposal is: piece, date, duration, measure range, hands/part, starting tempo, ending tempo, completion, and free notes.
7. Should practice time use a start/stop timer, manual entry, or both?
8. Would a weekly practice summary be useful, and should it emphasize time, consistency, pieces, tempo progress, or written reflections?
9. When sharing a score with your son, should Noted share only the clean score or optionally include your annotations and practice targets?
10. Should shared content create an independent copy for the recipient or remain linked so later updates can appear?
11. Are collections private per user, shareable, or can the family also maintain shared collections such as “Christmas” or “Duets”?
12. Can both learners edit shared catalog metadata, or should the person who imported an item control it?
13. Should the Library and Learn areas feel like two modes inside one application, or almost like two distinct applications with shared accounts and data?
14. Before designing mockups, which screen should we visualize first: home/dashboard, search results, work/edition details, library, score player, lesson, or practice history?

### Round 4 answers received

- Search results should lead with a composition and expose its editions within the work.
- Search should focus on music available through connected public-domain sources or the household's owned books, rather than attempting to be a universal works catalog initially.
- Adding a physical book by ISBN and discovering its contents is desirable. Because contents metadata may not exist, scanning a contents page and matching its entries should be considered.
- Source and provenance information should remain available after import when reference is needed.
- iPad imports should support several practical routes rather than a single source, including local files and connected or shared sources.
- The proposed common practice fields are acceptable as an initial model.
- Practice may be connected to a specific lesson/assignment or recorded independently.
- Summaries should include a calendar showing practice days and duration plus the pieces currently being worked on.
- Sharing may include the complete shared score context, but annotations and notes remain user-specific.
- Tags may be preferable to a separate collection construct; the exact organization model remains to be tested in design.
- A score has its own identity. Learners have separate relationships to the work, including per-user status and annotations. Inactive works should not clutter a learner's current list.
- Learn and Play should be two modes of the same application.
- Searchable centralization of works, combined with import and scanning, is the primary product priority. All proposed screens are eventually relevant.

### Round 5: priorities, score identity, tags, and first-release boundaries

1. If a work has two editions, can a learner be actively working on both, or should one edition be selected as their current practice score?
2. Are annotations tied to a specific score edition/file, while general notes and status are tied to the work?
3. If two users upload the exact same PDF separately, should Noted recognize it as one household score while preserving each user's privacy and annotations?
4. Should tags be attached to works globally, per household, per learner, or at more than one level?
5. Would a small number of built-in views—Favorites, Assigned, Learning, Playable, and Recent—plus user-created tags replace the need for collections?
6. When a work is in a physical book but has no digital score, should it still be addable to a learner's active list and assignments?
7. For book scanning, should Noted support photographing pages directly with the iPad camera, importing a scanner-created PDF, or both?
8. Should the first release attempt optical music recognition itself, or first support reliable playback only for MusicXML/MEI files obtained from public sources or uploaded by the user?
9. How important is playback compared with PDF annotation for the first personally useful release if automatic conversion proves difficult?
10. Should a lesson be a dated event containing multiple assignments, with practices optionally linked back to each assignment?
11. Should Noted support recurring lesson schedules and reminders, or only record dates initially?
12. Should a parent be able to see the son's practice summary, or should accounts remain fully private unless something is explicitly shared?
13. Does the Learn mode need anything in the first release, or can the first release focus entirely on Play while reserving the navigation and architecture for Learn?
14. Which three outcomes define a successful first release: find/import scores, catalog books, annotate scores, play structured scores, record lessons, track practice, or view progress?

### Round 5 answers received

- The work/piece is the primary identity for learner progress. Different editions still represent the same learned piece.
- Practice sessions attach to the work and may reference a passage and BPM; they may also retain the exact score context when useful.
- General learner state can belong to the work, while drawn annotations remain attached to the score asset.
- Tags are personal to the learner.
- Search, filtering, built-in status views, and tags are sufficient. Playlists and collections are deferred.
- Works available only in physical books can still be assigned and practiced without scanning. Practice can be captured using a timer or manual duration.
- A lesson is a dated record with free notes and multiple assignments; assignments may contain multiple detailed targets.
- Practice supports both a start/stop timer and manual entry.
- Practice data is private. User-controlled summary sharing may be considered later.
- Product delivery order is Play/Store, Lessons/Progress, then Learn.
- The three first-release outcomes are public-score search/import, structured-score playback, and PDF viewing/annotation.

### Round 6: MVP interaction and visual direction

1. After sign-in, should the default screen be the learner's current repertoire, a search page, or a dashboard combining both?
2. What should be visible on a work card: title, composer, difficulty, status, favorite, last practiced, available score/playback, and thumbnail?
3. When opening a work, should Noted immediately open the last-used score or first show a work details page with editions and activity?
4. In the score player, should the sheet music occupy nearly the entire screen with controls hidden until tapped?
5. Where should Apple Pencil annotation controls live so they remain accessible without reducing score space?
6. Should playback controls be a compact floating bar, a bottom panel, or a side panel?
7. During structured playback, should Noted automatically turn pages even though note highlighting is not required?
8. For PDFs, should measure numbers used in practice targets be entered manually, or should users be able to draw/select a rectangular passage on the page?
9. What should happen when the user taps “Practice”: start a timer immediately, choose a passage and goal first, or resume the last practice setup?
10. Should search feel closer to a library catalog with dense metadata or a visual browsing experience with covers and large cards?
11. Which visual mood fits Noted: traditional music-room elegance, quiet modern editorial, warm and playful family learning, technical practice studio, or a blend?
12. Do you prefer light mode, dark mode, or both? At the piano, should the score remain white even when surrounding controls are dark?
13. Are there colors, fonts, music apps, or websites whose visual style you especially like or dislike?
14. Should the first image-generated mockup show the portrait iPad score player, the search/library experience, or a paired concept showing both?

### Round 6 answers received

- The signed-in landing screen should be a dashboard optimized for quickly reopening current work.
- Opening a work may lead to a details page, though directly reopening the last-used score remains an interaction to test.
- In reading mode, notation is the dominant content and other interface elements should stay out of the way.
- Playback controls should appear as a compact floating bar after the user taps the score.
- Annotation mode is deliberately toggled on and off. Its floating palette initially needs only writing and erasing.
- Automatic page turning during playback is desirable. A moving vertical position line or note highlighting may be optional, but either could be distracting on complex scores and requires testing.
- PDF passage targets can use manually entered measure numbers initially; drawn passage selection is deferred.
- Starting practice should offer quick choices, such as resume/start immediately or configure the passage and tempo.
- Search should resemble a detailed library catalog; cover art and highly visual cards are not important.
- The visual style should be simple, utilitarian, and structured, with hard lines rather than decorative elegance. Multiple design directions should be compared before choosing.
- Light mode is sufficient initially. A dark score treatment is not currently desired.
- Initial visual exploration should show the dashboard/library and portrait iPad score player as a matched pair.

### Visual direction feedback received

- The preferred concept is the first generated option.
- Its cobalt-blue, white, and black palette should be retained.
- Familiar mobile-app bottom navigation is desirable.
- Current work should remain prominent at the top for fast resumption.
- The score player and floating playback bar are promising.
- The current measure-selection and looping interaction is not yet convincing and should be explored further.
- Typography and hard-edged controls fit the desired character.
- Dashboard whitespace is important; useful information should not make the screen feel cramped.
- Playlists should be removed.
- Weekly metrics should remain and the start of the week should be configurable, with Monday as a possible default.
- Priority order is storage/playback, tracking, then annotations.
- Playback loop selection should ideally let the learner navigate to a measure and set that current measure as the start or end. Manual measure-number fields are an acceptable fallback.
- Structured scores must expose measure numbering so passage references and loop controls are understandable.
- Weekly views default to Monday as the first day.
- Primary bottom navigation is Home, Library, Metronome, Practice, and Settings.
- Selecting a current piece may first open a details screen with work information and statistics; this remains subject to usability testing.
- Practice tracking starts only after the learner explicitly taps Start Practice; playback alone does not imply a recorded practice session.
- The next visual iteration should again show dashboard and score player together.

### Second visual refinement feedback

- Dashboard search is redundant because Library provides search and filtering.
- Replace the Search bottom-navigation destination with Metronome.
- Metronome should provide basic sounds and configuration.
- The refined score player became too cluttered.
- Remove the unexplained standalone `m. 9` control.
- Restore one compact `Measures #-#` range display in the playback bar.
- Tapping the range opens a minimal popover containing only the start and end measure numbers.
- Restore the independent lower-left pencil button as the conventional entry into score markup.

### Baseline reset

- The original first mockup remains closest to the intended product.
- Subsequent changes should be applied narrowly to that baseline instead of redesigning the layout.
- Monday is the default first day in weekly metrics.
- Bottom navigation is Home, Library, Metronome, Practice, Settings.
- Remove the duplicate settings gear from the dashboard header and retain the account/profile icon.
- Preserve the original search field and overall dashboard/score-player composition for this revision.

### Round 7: visual evaluation prompts

After reviewing mockups:

1. Which direction feels most like Noted, and which feels least appropriate?
2. Which dashboard elements should be added, removed, or reordered?
3. Does the information density feel appropriate at arm's length on a 13-inch iPad?
4. Does the score player leave enough room for the music?
5. Are the playback bar and annotation tools discoverable without becoming distracting?
6. Should the Play/Learn mode switch be persistent or live inside navigation?
7. Should the interface feel more like a focused instrument, a library database, or a personal practice notebook?

### Later rounds

- Repertoire metadata, editions, public-domain sources, and ingestion.
- Score display, formats, annotations, playback, and MIDI.
- Practice tracking, lesson workflows, goals, and progress models.
- Theory curriculum, exercises, assessment, and personalization.
- Family, teacher, student, sharing, privacy, and account roles.
- iPad interaction, accessibility, offline use, and visual design.
- Technical architecture, storage, search, integrations, and deployment.
- MVP boundaries, risks, sequencing, and success criteria.

## Naming seed

**Noted** is a strong working name: short, musical, memorable, and relevant both to musical notes and recorded knowledge. Naming should remain open until the product's center is clearer. Potential naming criteria include domain and trademark availability, searchability, tone, and whether the name feels equally natural for library, practice, and learning experiences.
