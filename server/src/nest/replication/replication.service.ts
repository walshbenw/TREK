import { Injectable } from '@nestjs/common';
import * as svc from '../../services/replicationService';
import * as scheduler from '../../scheduler';

/**
 * Thin Nest wrapper around the SQLite→Postgres mirror service. All engine logic
 * (snapshot, introspection, upsert + delete-reconcile) lives in the plain service
 * module; this only re-exposes it for DI and re-arms the scheduler on settings save.
 */
@Injectable()
export class ReplicationService {
  /** Combined view for the admin UI — never returns the raw connection string. */
  getSettings() {
    return svc.getSettingsView();
  }

  /** Persist schedule settings (+ optional connection string) and re-arm the cron. */
  saveSettings(body: Record<string, unknown>) {
    const current = svc.loadSettings();
    const parseInt10 = (v: unknown, fallback: number) => {
      const n = typeof v === 'number' ? v : parseInt(String(v), 10);
      return Number.isFinite(n) ? n : fallback;
    };
    const interval =
      typeof body.interval === 'string' && scheduler.VALID_INTERVALS.includes(body.interval)
        ? body.interval
        : current.interval;
    const settings = {
      enabled: body.enabled === true || body.enabled === 'true' || body.enabled === 1,
      interval,
      hour: Math.min(23, Math.max(0, parseInt10(body.hour, current.hour))),
      day_of_week: Math.min(6, Math.max(0, parseInt10(body.day_of_week, current.day_of_week))),
      day_of_month: Math.min(28, Math.max(1, parseInt10(body.day_of_month, current.day_of_month))),
    };
    svc.saveSettings(settings);

    // Store/replace the connection string only when a new value was supplied
    // (the mask sentinel means "keep existing").
    if (typeof body.pg_url === 'string') {
      svc.setPgUrl(body.pg_url);
    }

    // Re-arm the cron so schedule/enable changes take effect without a restart.
    scheduler.startReplication();
    return svc.getSettingsView();
  }

  testConnection(body: Record<string, unknown>) {
    const url = typeof body?.pg_url === 'string' ? body.pg_url : undefined;
    return svc.testConnection(url);
  }

  runNow() {
    return svc.runReplication();
  }
}
