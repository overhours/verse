# Verse

Desktop lyrics app (Electron + React). Paste a Spotify/SoundCloud link, type a song name, or open an audio file to get lyrics, save songs to a library, and — with **AI Lyrics Reconstruction** — transcribe a song's actual vocals into word-timed, editable lyrics.

```bash
npm.cmd install
npm.cmd start      # build and run
npm.cmd test       # unit tests
npm.cmd run dist   # Windows installer (release/)
```

## Features

- **Karaoke:** full-screen view with each word filling in as it's sung, the next lines below, a countdown in instrumental gaps, and **Sing along**, which plays the instrumental left over after vocal separation. Keys: Space, ←/→, F (full screen), Esc.
- **Import lyrics** (song page → Import lyrics): from a `.lrc` or `.txt` file, a Genius search, or pasted text, with a preview first. LRC timestamps can be kept or re-timed by AI. Nothing existing is replaced without confirmation.
- **Sync with AI:** times your own lyrics to the song. Verse transcribes the vocals, then aligns your words to what was sung, so the timing comes from the audio (not lyric length). Your text, line order and [Verse]/[Chorus] sections are kept; words it couldn't hear are flagged for review in the editor.
- **Genius search** uses the official Genius API (`GENIUS_ACCESS_TOKEN`, a free Client Access Token from https://genius.com/api-clients), for song details and artwork. Genius doesn't provide lyrics through its API and its terms forbid scraping, so the lyrics text comes from LRCLIB. If LRCLIB doesn't have a song, Verse says so and links to the Genius page.
- **Embed lyrics into audio** (song page → More, or the editor's Export menu): writes a new copy. The original file is never modified. MP3 gets ID3v2 USLT + SYLT (synchronised) frames; FLAC/OGG/Opus get the `LYRICS` Vorbis comment as LRC text; M4A gets `©lyr` as LRC text (M4A has no standard timed-lyrics tag). Existing tags and artwork are kept, and a `.lrc` can be saved next to the copy. WAV has no lyrics metadata, so it offers a `.lrc` export instead.
- **Tap-to-sync** (More → Time lyrics by tapping, or **Tap to sync** in the editor): play the song and press Space as each line starts. Backspace goes back a line, Esc stops.
- **Import a music folder** (library ⋯ menu): adds every audio file in a folder and its subfolders, finds lyrics online, and can analyse songs that have none, one at a time in the background. Also on that menu: **Analyse songs missing lyrics**, **Back up library**, **Restore from backup** (restore merges and never overwrites existing songs).
- **GPU acceleration:** vocal separation runs on any DirectX 12 graphics card (AMD, NVIDIA, Intel) through DirectML, falling back to the CPU.
- Analyses keep running if you leave the AI screen and are saved to the library when they finish. A desktop notification appears if Verse isn't in front.
- Library sorting (recent, title, artist) and badges for AI lyrics and songs without lyrics. The window remembers its size and position.

## AI Lyrics Reconstruction

Open it from the sidebar, or press **Analyse with AI** on any song from a local audio file.

### Pipeline

The rule throughout: **only audio evidence changes a word.** Context, published lyrics, chorus repeats and Claude can add *suggestions* (shown in the editor) and flags, but the transcript only changes where a recognition pass actually heard the new word at that moment.

| Stage | What runs |
|---|---|
| 1. Audio and vocal sections | Hash the file (cache key), probe it, isolate the vocals (**free:** UVR MDX-Net Kim Vocal 2 via ONNX Runtime on this PC; **cloud:** Demucs on Replicate; falls back to the full mix), then find the vocal sections from the stem's energy. |
| 2. Main vocals | **Free:** Whisper via whisper.cpp on this PC with DTW word timing. *Balanced* = large-v3-turbo (~583 MB); *Maximum* = full large-v3 (~1.0 GB, roughly twice as long). Both are one-time downloads, SHA-256 verified, nothing uploaded. **Cloud:** WhisperX (forced alignment, optional speaker labels) or OpenAI Whisper. The prompt asks for verbatim lyrics (tryna, askin', ain't) and never for the song's published lyrics. Hallucinated phrases and words over silent vocals are removed; a phrase-final word stamped just after the voice stops is moved back instead of deleted. |
| 3. Backing vocals and ad-libs | Phrases sung far below the lead (on the isolated vocals) are marked backing. Vocal sections no lead word covers are transcribed separately, without a lyric prompt, and kept as backing. Backing lines are exported in parentheses. Overlapping backing under the lead is not split out. |
| 4. Word alignment | Each word is tightened to the vocal energy (backing words are left alone), then forced into strict chronological order: no two words share a timestamp. |
| 5. Correction using the audio | Words under 80% confidence get an independent second listen. Agreement marks the word *heard twice* and raises its confidence; a different reading replaces it only if it is clearly more confident (otherwise it becomes a suggestion). Published lyrics (library or LRCLIB) only replace a word the recogniser was unsure of, between agreeing words. Claude (optional key) proposes edits that are applied only if the second listen heard the same word there. Chorus repeats are compared, not copied. |
| 6. Confidence | ≥ 80%: accepted. 50–80%: kept, after the second listen above. < 50%: flagged for review. < 20%, not confirmed by a second listen: shown as `[unclear]` with the guess kept for the reviewer. |
| 7. Validate LRC | Splits the words into lines at natural phrase breaks (scored on pauses, punctuation, Whisper's line capitals and rhymes; never after words like "the", "my", "and" unless there is a real pause), then checks the LRC is well-formed and in time order; any problem is shown as a note. |

Progress bars appear only when there is real progress (ffmpeg position, model log percentages, chunks, re-checked passages); otherwise the current stage is shown. Analysis runs as a background job in the main process and can be cancelled. Every stage's output is cached per audio hash and settings, so retries and re-runs skip finished work.

### API keys

Add keys in **AI Lyrics Reconstruction → AI providers**. They are stored encrypted with Windows' secure storage (DPAPI), live only in the main process, and are never sent to the UI. Alternatively set environment variables, which take priority:

| Variable | Needed for | Get one |
|---|---|---|
| `REPLICATE_API_TOKEN` | Demucs vocal separation + WhisperX (recommended) | https://replicate.com/account/api-tokens |
| `OPENAI_API_KEY` | Alternative transcriber (OpenAI Whisper) | https://platform.openai.com/api-keys |
| `ANTHROPIC_API_KEY` | Optional Claude refinement | https://console.anthropic.com/settings/keys |
| `HF_TOKEN` | Optional vocalist identification (WhisperX). Accept the terms for `pyannote/speaker-diarization-3.1` and `pyannote/segmentation-3.0` first. | https://huggingface.co/settings/tokens |

No key is needed for the free engine: press **Download free engine** on the analysis screen. Keys only add cloud options (vocal separation, forced alignment, vocalist labels, Claude review). Example for one PowerShell session:

```powershell
$env:REPLICATE_API_TOKEN = "r8_..."
npm.cmd start
```

Set `FFMPEG_PATH` to use your own ffmpeg instead of the bundled one.

### Testing accuracy

`npm.cmd test` runs the unit tests, including eight regression phrases (for example *ever married me* vs *never married me*, *I command you* vs *I could man you*). They check that no stage (published lyrics, Claude edits, the second listen, chorus repeats) replaces what was sung with the similar-sounding wrong phrase. They are tests, not replacement rules: nothing in the app looks for those phrases.

### Editor

Word-by-word karaoke highlighting with auto-scroll, click-to-seek, original/vocals-only A/B playback and 0.5×/0.75× speed. You can edit words (type several to split one), set start/end times precisely, nudge ±50 ms or snap to the playhead (`[` / `]`), replay a line, add/delete/split/join lines, step through the words to review (**N** plays the next one, **A** accepts, **U** marks it `[unclear]`, **1–9** takes a suggestion from a second listen, published lyrics, a chorus repeat or Claude), re-split lines at phrase breaks (the wrap button, for older analyses), switch between word- and line-level timing, undo/redo, and save to the library.

Exports: LRC, Enhanced LRC (word timestamps), SRT, JSON (timestamps + confidence), TXT.

Only analyse audio you own or have permission to use. Transcriptions are AI-generated and can be wrong; review flagged words before relying on them.

## Releasing an update

Installed copies check [overhours/verse-updates](https://github.com/overhours/verse-updates) every 2 minutes, download new versions in the background, and show a flashing **Update** button.

1. Bump `version` in `package.json` (it must be higher than the last release).
2. `npm run dist`
3. Publish (the notes are what users see on the update screen):

```bash
gh release create v1.2.3 -R overhours/verse-updates --title "Verse 1.2.3" --notes "What changed" release/Verse-Setup-1.2.3.exe release/Verse-Setup-1.2.3.exe.blockmap release/latest.yml
```

All three files are required: `latest.yml` tells the app a new version exists, and the `.blockmap` lets it download only the changed parts.
