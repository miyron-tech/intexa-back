import { Module } from '@nestjs/common';
import { TelegramOutboxService } from './telegram-outbox.service.js';

@Module({ providers: [TelegramOutboxService] })
export class NotificationsModule {}
