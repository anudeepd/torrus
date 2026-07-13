import { File, FileArchive, FileImage, FileText, Folder } from 'lucide-react'
import type { SFTPEntry } from '@/types'

export default function FileIcon({ entry }: { entry: SFTPEntry }) {
  if (entry.type === 'directory') return <Folder className="h-4 w-4 text-brand-400" />
  const name = entry.name.toLowerCase()
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(name)) return <FileImage className="h-4 w-4 text-slate-400" />
  if (/\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/.test(name)) return <FileArchive className="h-4 w-4 text-slate-400" />
  if (/\.(txt|md|json|ya?ml|toml|py|ts|tsx|js|jsx|css|html|sh|go|rs|rb)$/.test(name)) {
    return <FileText className="h-4 w-4 text-slate-400" />
  }
  return <File className="h-4 w-4 text-slate-500" />
}
