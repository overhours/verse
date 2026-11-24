import { useState } from 'react'
import { FileAudio, FileText, Sparkles } from 'lucide-react'
import { api, Track } from './api'
import { Button } from './ui'

// Front door for the existing "match your lyrics to the vocals" AI flow: one audio file + its lyrics text.
export default function SyncLyrics({ onStart, onError }: { onStart: (track: Track, lyrics: string) => void; onError: (m: string) => void }) {
  const [track, setTrack] = useState<Track | null>(null)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)

  const pickSong = () => api.pick().then((t) => t && setTrack(t)).catch((e: Error) => onError(e.message))
  const pickTxt = () => api.openLyricsFile().then((f) => { if (f) { setText(f.text); setFileName(f.name) } }).catch((e: Error) => onError(e.message))
  const ready = !!track && !!text.trim()

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-6 pt-8 pb-20 min-[1000px]:px-10">
        <header className="enter">
          <p className="text-[13px] text-muted">MP3 + lyrics in, timestamped .lrc out</p>
          <h1 className="t-display mt-2">Sync lyrics</h1>
          <p className="mt-3 max-w-[560px] text-[14px] leading-relaxed text-muted">
            Already have the words but no timing? Give Verse the song and its lyrics. The AI listens to the vocals and stamps
            every line with the moment it's sung, so they scroll along in karaoke and export as a .lrc file.
          </p>
        </header>

        <section className="enter-2 mt-8">
          <h2 className="mb-3 text-[15px] font-semibold">1. Song</h2>
          <div className="flex items-center gap-3">
            <Button icon={<FileAudio size={14} />} onClick={pickSong}>{track ? 'Change song' : 'Choose audio file'}</Button>
            {track && <span className="min-w-0 truncate text-[13px] text-muted">{track.title}{track.artist ? ` · ${track.artist}` : ''}</span>}
          </div>
        </section>

        <section className="enter-3 mt-8">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold">2. Lyrics</h2>
            <Button size="sm" icon={<FileText size={14} />} onClick={pickTxt}>Open .txt</Button>
          </div>
          <textarea value={text} onChange={(e) => { setText(e.target.value); setFileName(null) }} aria-label="Lyrics"
            placeholder="Paste the lyrics here, one line per lyric line…" className="field min-h-[280px] w-full resize-y py-3 leading-relaxed" />
          {fileName && <p className="mt-1.5 text-[12px] text-muted">from {fileName}</p>}
        </section>

        <div className="mt-8 flex items-center gap-4">
          <Button variant="primary" icon={<Sparkles size={15} />} disabled={!ready} onClick={() => track && onStart(track, text)}>Sync with AI</Button>
          <p className="text-[12.5px] text-muted">Next you pick the AI settings. Once it's done, export as .lrc from the song page.</p>
        </div>
      </div>
    </div>
  )
}
