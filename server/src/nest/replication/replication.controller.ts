import { Body, Controller, Get, HttpCode, HttpException, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../../types';
import { ReplicationService } from './replication.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { writeAudit, getClientIp } from '../../services/auditLog';

/**
 * /api/replication — admin-only management of the SQLite→Postgres mirror:
 * read/save schedule settings + connection string, test the connection, and
 * trigger a manual run. Admin-gated at the class level, matching BackupController.
 */
@Controller('api/replication')
@UseGuards(JwtAuthGuard, AdminGuard)
export class ReplicationController {
  constructor(private readonly repl: ReplicationService) {}

  @Get('settings')
  getSettings() {
    try {
      return this.repl.getSettings();
    } catch (err) {
      console.error('[replication] GET settings:', err);
      throw new HttpException({ error: 'Could not load replication settings' }, 500);
    }
  }

  @Put('settings')
  saveSettings(@CurrentUser() user: User, @Body() body: Record<string, unknown>, @Req() req: Request) {
    try {
      const view = this.repl.saveSettings(body || {});
      writeAudit({
        userId: user.id,
        action: 'replication.settings',
        ip: getClientIp(req),
        details: { enabled: view.settings.enabled, interval: view.settings.interval, pgUrlSet: view.pgUrlSet },
      });
      return view;
    } catch (err) {
      console.error('[replication] PUT settings:', err);
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpException(
        { error: 'Could not save replication settings', detail: process.env.NODE_ENV?.toLowerCase() !== 'production' ? msg : undefined },
        500,
      );
    }
  }

  @Post('test')
  @HttpCode(200)
  async test(@Body() body: Record<string, unknown>) {
    return this.repl.testConnection(body || {});
  }

  @Post('run')
  @HttpCode(200)
  async run(@CurrentUser() user: User, @Req() req: Request) {
    const status = await this.repl.runNow();
    writeAudit({
      userId: user.id,
      action: 'replication.run',
      ip: getClientIp(req),
      details: { ok: status.ok, tables: status.tables.length, error: status.error },
    });
    return { success: status.ok, status };
  }
}
