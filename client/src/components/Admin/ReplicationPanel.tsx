import { useState, useEffect } from 'react'
import { replicationApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import { Database, Clock, Check, Play, PlugZap, CheckCircle, XCircle } from 'lucide-react'
import { useTranslation } from '../../i18n'
import CustomSelect from '../shared/CustomSelect'

const INTERVAL_OPTIONS = [
  { value: 'hourly', labelKey: 'backup.interval.hourly' },
  { value: 'daily', labelKey: 'backup.interval.daily' },
  { value: 'weekly', labelKey: 'backup.interval.weekly' },
  { value: 'monthly', labelKey: 'backup.interval.monthly' },
]

const DAYS_OF_WEEK = [
  { value: 0, labelKey: 'backup.dow.sunday' },
  { value: 1, labelKey: 'backup.dow.monday' },
  { value: 2, labelKey: 'backup.dow.tuesday' },
  { value: 3, labelKey: 'backup.dow.wednesday' },
  { value: 4, labelKey: 'backup.dow.thursday' },
  { value: 5, labelKey: 'backup.dow.friday' },
  { value: 6, labelKey: 'backup.dow.saturday' },
]

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const DAYS_OF_MONTH = Array.from({ length: 28 }, (_, i) => i + 1)

interface ReplicationSettings {
  enabled: boolean
  interval: string
  hour: number
  day_of_week: number
  day_of_month: number
}

interface TableResult { name: string; rows: number; action: string }
interface ReplicationStatus {
  startedAt: string
  finishedAt: string
  ok: boolean
  error?: string
  durationMs: number
  tables: TableResult[]
}

const SECRET_MASK = '••••••••'

export default function ReplicationPanel() {
  const [settings, setSettings] = useState<ReplicationSettings>({ enabled: false, interval: 'daily', hour: 3, day_of_week: 0, day_of_month: 1 })
  const [pgUrl, setPgUrl] = useState('')
  const [pgUrlSet, setPgUrlSet] = useState(false)
  const [status, setStatus] = useState<ReplicationStatus | null>(null)
  const [timezone, setTimezone] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [running, setRunning] = useState(false)
  const toast = useToast()
  const { t, locale } = useTranslation()

  const load = async () => {
    try {
      const data = await replicationApi.getSettings()
      setSettings(data.settings)
      setStatus(data.status || null)
      setTimezone(data.timezone || '')
      setPgUrlSet(!!data.pgUrlSet)
    } catch {
      toast.error(t('replication.toast.loadError'))
    }
  }

  useEffect(() => { load() }, [])

  const change = (key: keyof ReplicationSettings, value: unknown) => {
    setSettings(prev => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  // Send the connection string only when the admin typed a new value; a blank
  // field means "keep the stored one" (mirrors the SMTP secret convention).
  const pgUrlPayload = () => (pgUrl.trim() ? { pg_url: pgUrl.trim() } : {})

  const handleSave = async () => {
    setSaving(true)
    try {
      const data = await replicationApi.saveSettings({ ...settings, ...pgUrlPayload() })
      setSettings(data.settings)
      setPgUrlSet(!!data.pgUrlSet)
      setPgUrl('')
      setDirty(false)
      toast.success(t('replication.toast.saved'))
    } catch {
      toast.error(t('replication.toast.saveError'))
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const d = await replicationApi.test(pgUrlPayload())
      setConnected(!!d.connected)
      if (d.connected) toast.success(t('replication.toast.testSuccess'))
      else toast.error(d.error || t('replication.toast.testFailed'))
    } catch {
      setConnected(false)
      toast.error(t('replication.toast.testFailed'))
    } finally {
      setTesting(false)
    }
  }

  const handleRun = async () => {
    setRunning(true)
    try {
      const d = await replicationApi.run()
      setStatus(d.status || null)
      if (d.success) toast.success(t('replication.toast.runSuccess'))
      else toast.error(d.status?.error || t('replication.toast.runFailed'))
    } catch {
      toast.error(t('replication.toast.runFailed'))
    } finally {
      setRunning(false)
    }
  }

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-'
    try {
      const opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }
      if (timezone) opts.timeZone = timezone
      return new Date(dateStr).toLocaleString(locale, opts)
    } catch { return dateStr }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Connection */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-center gap-3 mb-6">
          <Database className="w-5 h-5 text-gray-400" />
          <div>
            <h2 className="font-semibold text-content">{t('replication.title')}</h2>
            <p className="text-xs mt-1 text-content-muted">{t('replication.subtitle')}</p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <label className="block text-sm font-medium text-gray-700">{t('replication.connection.urlLabel')}</label>
          <input
            type="password"
            value={pgUrl}
            onChange={e => { setPgUrl(e.target.value); setConnected(null) }}
            placeholder={pgUrlSet ? SECRET_MASK : t('replication.connection.urlPlaceholder')}
            autoComplete="off"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
          />
          <p className="text-xs text-gray-400">{t('replication.connection.urlHint')}</p>

          <div className="flex items-center gap-3">
            <button
              onClick={handleTest}
              disabled={testing}
              className="flex items-center gap-2 border border-gray-200 text-gray-700 px-3 py-2 rounded-lg hover:bg-gray-50 text-sm font-medium disabled:opacity-60"
            >
              {testing
                ? <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                : <PlugZap className="w-4 h-4" />}
              {testing ? t('replication.testing') : t('replication.test')}
            </button>

            {connected === true && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-600">
                <span className="w-2 h-2 bg-green-500 rounded-full" /> {t('replication.connected')}
              </span>
            )}
            {connected === false && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
                <span className="w-2 h-2 bg-slate-300 rounded-full" /> {t('replication.notConnected')}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Schedule */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <div className="flex items-center gap-3 mb-6">
          <Clock className="w-5 h-5 text-gray-400" />
          <div>
            <h2 className="font-semibold text-content">{t('replication.schedule.title')}</h2>
            <p className="text-xs mt-1 text-content-muted">{t('replication.schedule.subtitle')}</p>
          </div>
        </div>

        <div className="flex flex-col gap-5">
          {/* Enable toggle */}
          <label className="flex items-center justify-between gap-4 cursor-pointer">
            <div className="min-w-0">
              <span className="text-sm font-medium text-gray-900">{t('replication.enable')}</span>
              <p className="text-xs text-gray-500 mt-0.5">{t('replication.enableHint')}</p>
            </div>
            <button
              onClick={() => change('enabled', !settings.enabled)}
              className="relative shrink-0 inline-flex h-6 w-11 items-center rounded-full transition-colors"
              style={{ background: settings.enabled ? 'var(--text-primary)' : 'var(--border-primary)' }}
            >
              <span className="absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform duration-200"
                style={{ transform: settings.enabled ? 'translateX(20px)' : 'translateX(0)' }} />
            </button>
          </label>

          {settings.enabled && (
            <>
              {/* Interval */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">{t('replication.interval')}</label>
                <div className="flex flex-wrap gap-2">
                  {INTERVAL_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => change('interval', opt.value)}
                      className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                        settings.interval === opt.value
                          ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-700'
                          : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {t(opt.labelKey)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Hour (daily/weekly/monthly) */}
              {settings.interval !== 'hourly' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">{t('replication.hour')}</label>
                  <CustomSelect
                    value={String(settings.hour)}
                    onChange={v => change('hour', parseInt(String(v), 10))}
                    size="sm"
                    options={HOURS.map(h => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))}
                  />
                  <p className="text-xs text-gray-400 mt-1">{timezone ? `Timezone: ${timezone}` : ''}</p>
                </div>
              )}

              {/* Day of week (weekly) */}
              {settings.interval === 'weekly' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">{t('replication.dayOfWeek')}</label>
                  <div className="flex flex-wrap gap-2">
                    {DAYS_OF_WEEK.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => change('day_of_week', opt.value)}
                        className={`px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${
                          settings.day_of_week === opt.value
                            ? 'bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 border-slate-700'
                            : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        {t(opt.labelKey)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Day of month (monthly) */}
              {settings.interval === 'monthly' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">{t('replication.dayOfMonth')}</label>
                  <CustomSelect
                    value={String(settings.day_of_month)}
                    onChange={v => change('day_of_month', parseInt(String(v), 10))}
                    size="sm"
                    options={DAYS_OF_MONTH.map(d => ({ value: String(d), label: String(d) }))}
                  />
                </div>
              )}
            </>
          )}

          {/* Actions */}
          <div className="flex items-center justify-between pt-2 border-t border-gray-100">
            <button
              onClick={handleRun}
              disabled={running}
              className="flex items-center gap-2 border border-gray-200 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-50 text-sm font-medium disabled:opacity-60"
            >
              {running
                ? <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                : <Play className="w-4 h-4" />}
              {running ? t('replication.running') : t('replication.runNow')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !dirty}
              className="flex items-center gap-2 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 px-5 py-2 rounded-lg hover:bg-slate-900 text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {saving
                ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                : <Check className="w-4 h-4" />}
              {saving ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </div>
      </div>

      {/* Last run status */}
      <div className="bg-white rounded-2xl border border-gray-200 p-6">
        <h2 className="font-semibold text-content mb-4">{t('replication.lastRun.title')}</h2>
        {!status ? (
          <p className="text-sm text-gray-400">{t('replication.lastRun.never')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              {status.ok
                ? <CheckCircle className="w-5 h-5 text-emerald-500" />
                : <XCircle className="w-5 h-5 text-red-500" />}
              <span className="text-sm font-medium text-gray-900">
                {status.ok ? t('replication.lastRun.success') : t('replication.lastRun.failed')}
              </span>
              <span className="text-xs text-gray-400">{formatDate(status.finishedAt)}</span>
            </div>
            {status.error && <p className="text-xs text-red-600">{status.error}</p>}
            {status.ok && (
              <p className="text-xs text-gray-500">
                {t('replication.lastRun.tables', {
                  tables: String(status.tables.length),
                  rows: String(status.tables.reduce((n, tbl) => n + tbl.rows, 0)),
                  ms: String(status.durationMs),
                })}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
