// Ícone por tipo de arquivo (cards de present_file, cabeçalho do painel de arquivo).
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Globe,
  type LucideIcon
} from 'lucide-react'
import type { ViewerKind } from '@shared/types'
import { fileExtOf, kindFromName } from '@shared/fileViewer'

const ARCHIVE = new Set('zip gz tgz bz2 xz zst 7z rar tar jar war apk dmg iso deb rpm'.split(' '))
const VIDEO = new Set('mp4 m4v mkv mov avi webm wmv flv 3gp'.split(' '))
const AUDIO = new Set('mp3 wav ogg oga flac m4a aac opus mid midi'.split(' '))
const SHEET = new Set('xls xlsx ods csv tsv numbers'.split(' '))

export function fileIcon(name: string, kind?: ViewerKind): { icon: LucideIcon; tone: string } {
  const k = kind ?? kindFromName(name) ?? 'binary'
  const ext = fileExtOf(name)
  if (SHEET.has(ext)) return { icon: FileSpreadsheet, tone: 'text-success/80' }
  switch (k) {
    case 'markdown':
    case 'text':
      return { icon: FileText, tone: 'text-accent-strong' }
    case 'html':
      return { icon: Globe, tone: 'text-sky-400/90' }
    case 'image':
      return { icon: FileImage, tone: 'text-emerald-400/90' }
    case 'pdf':
      return { icon: FileText, tone: 'text-danger/90' }
    case 'video':
      return { icon: FileVideo, tone: 'text-violet-400/90' }
    case 'code':
      return { icon: FileCode, tone: 'text-warning/90' }
    default:
      if (ARCHIVE.has(ext)) return { icon: FileArchive, tone: 'text-muted' }
      if (VIDEO.has(ext)) return { icon: FileVideo, tone: 'text-muted' }
      if (AUDIO.has(ext)) return { icon: FileAudio, tone: 'text-muted' }
      return { icon: File, tone: 'text-muted' }
  }
}
