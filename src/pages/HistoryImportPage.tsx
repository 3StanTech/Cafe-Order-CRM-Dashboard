import { useStorageAdapter } from '../data/useStorageAdapter'
import { HistoryImportWorkspace } from '../features/history-import/HistoryImportWorkspace'

export function HistoryImportPage() {
  const { adapter, error } = useStorageAdapter()

  if (error) return <p role="alert" className="rounded-xl bg-red-50 p-4 text-red-800">{error}</p>
  if (!adapter) return <p className="text-sm text-[#4A5365]">Preparing local order storage…</p>
  return <HistoryImportWorkspace adapter={adapter} />
}
